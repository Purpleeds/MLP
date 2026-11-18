#!/usr/bin/env python3
"""MLP "Train on my songs": a LoRA fine-tune of Whisper on the songs this PC has heard.

Data: <data>/songs/<song>/audio.wav (16 kHz mono, song time) + song.json (lyrics lines with times,
which lines are trusted, covered ranges), written by the app while songs with synced lyrics play.

    python mlp_train.py stats --data DIR
    python mlp_train.py run   --data DIR [--max-hours 5] [--smoke] [--quantize whisper-quantize.exe]

`run`: split songs into train / held-out (held-out songs stay held out across runs), cut ≤ 28 s windows
of whole trusted lines, measure the original model on the held-out windows, train LoRA adapters
(encoder + decoder) until the time budget, measure again, and only when the tuned model is better,
merge it, convert it to whisper.cpp's ggml format and make it the model the app uses
(<data>/models/current.json). Progress is printed as JSON lines (one object per line).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import shutil
import subprocess
import sys
import time
import urllib.request
import wave
from datetime import datetime, timezone
from pathlib import Path

BASE_MODEL = "openai/whisper-large-v3-turbo"
# whisper.cpp's converter for Hugging Face Whisper checkpoints, pinned to the release the app runs.
CONVERTER_URL = "https://raw.githubusercontent.com/ggml-org/whisper.cpp/b5454/models/convert-h5-to-ggml.py"
SR = 16_000
WIN_MS = 28_000
MAX_WIN_MS = 30_000
HELD_OUT_SHARE = 0.2
RESERVE_S = 15 * 60
# Below this the comparison is too noisy to switch models on.
MIN_HELD_SONGS = 3
MIN_HELD_UNITS = 300  # time kept back for measuring + exporting
CJK = ("ja", "zh", "yue", "ko", "th", "lo", "my", "km")


def emit(event: str, **kw) -> None:
    print(json.dumps({"event": event, **kw}, ensure_ascii=False), flush=True)


def log(msg: str) -> None:
    emit("log", message=msg)


# ---------------------------------------------------------------- data
def read_wav(path: Path):
    import numpy as np

    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != 2 or w.getframerate() != SR:
            raise ValueError(f"{path}: expected 16-bit {SR} Hz")
        raw = w.readframes(w.getnframes())
        ch = w.getnchannels()
    a = np.frombuffer(raw, dtype="<i2").astype("float32") / 32768.0
    return a.reshape(-1, ch).mean(axis=1) if ch > 1 else a


def load_songs(data: Path) -> list[dict]:
    out = []
    for d in sorted((data / "songs").glob("*")):
        meta_p, audio_p = d / "song.json", d / "audio.wav"
        if not (meta_p.is_file() and audio_p.is_file()):
            continue
        try:
            meta = json.loads(meta_p.read_text(encoding="utf-8"))
        except Exception as e:  # a hand-edited / broken file: skip it
            log(f"skipping {d.name}: {e}")
            continue
        if meta.get("format") != "MLP training clip":
            continue
        meta["dir"] = d
        meta["audio"] = audio_p
        out.append(meta)
    return out


def song_id(s: dict) -> str:
    return s.get("songKey") or s["dir"].name


def stable_hash(text: str) -> int:
    return int(hashlib.sha256(text.encode("utf-8")).hexdigest()[:8], 16)


def split_songs(songs: list[dict], data: Path) -> tuple[list[dict], list[dict]]:
    """Held-out songs are picked once (by a hash of the song) and stay held out in later runs."""
    p = data / "split.json"
    saved = json.loads(p.read_text(encoding="utf-8")) if p.is_file() else {"heldOut": [], "train": []}
    held, train = set(saved.get("heldOut", [])), set(saved.get("train", []))
    for s in songs:
        k = song_id(s)
        if k not in held and k not in train:
            (held if stable_hash(k) % 100 < HELD_OUT_SHARE * 100 else train).add(k)
    ids = [song_id(s) for s in songs]
    present_held = [k for k in ids if k in held]
    present_train = [k for k in ids if k in train]
    # Two or more songs: at least one on each side.
    if len(ids) >= 2 and not present_held:
        k = min(present_train, key=stable_hash)
        train.discard(k)
        held.add(k)
    if len(ids) >= 2 and not [k for k in ids if k in train]:
        k = max(present_held, key=stable_hash)
        held.discard(k)
        train.add(k)
    p.write_text(json.dumps({"heldOut": sorted(held), "train": sorted(train)}, ensure_ascii=False, indent=1), encoding="utf-8")
    return [s for s in songs if song_id(s) in train], [s for s in songs if song_id(s) in held]


def covered(ranges, a: float, b: float) -> bool:
    return any(x <= a + 40 and y + 40 >= b for x, y in ranges)


def usable(line: dict) -> bool:
    """Trusted, and real words: not Bopomofo humming ("ㄌㄚ ㄒ一") or only symbols."""
    t = line.get("text", "")
    return bool(line.get("trusted")) and not any("㄀" <= c <= "ㄯ" or "ㆠ" <= c <= "ㆿ" for c in t) and any(c.isalnum() for c in t)


def windows(song: dict) -> list[dict]:
    """≤ 28 s stretches of consecutive trusted lines, cut halfway into the pauses around them."""
    lines = sorted([l for l in song.get("lines", []) if l.get("text", "").strip()], key=lambda l: l["start"])
    cov = song.get("covered", [])
    dur = song.get("durationMs") or (max((b for _, b in cov), default=0))
    out, i, n = [], 0, len(lines)
    while i < n:
        first = lines[i]
        if not usable(first) or not covered(cov, first["start"], first["end"]):
            i += 1
            continue
        j = i
        while (
            j + 1 < n
            and usable(lines[j + 1])
            and lines[j + 1]["end"] - first["start"] <= WIN_MS - 1000
            and lines[j + 1]["start"] - lines[j]["end"] < 8000
            and covered(cov, first["start"], lines[j + 1]["end"])
        ):
            j += 1
        prev_end = lines[i - 1]["end"] if i > 0 else 0
        next_start = lines[j + 1]["start"] if j + 1 < n else dur
        a = first["start"] - min(500, max(0, (first["start"] - prev_end) / 2))
        b = lines[j]["end"] + min(800, max(0, (next_start - lines[j]["end"]) / 2))
        b = min(b, a + MAX_WIN_MS)
        if b - a >= 1500 and covered(cov, a, b):
            sel = lines[i : j + 1]
            out.append({
                "song": song_id(song),
                "from": a,
                "to": b,
                "lines": [{"start": l["start"] - a, "end": l["end"] - a, "text": l["text"].strip()} for l in sel],
                # timestamps are only taught where the times came from the singing itself
                "timestamps": all(l.get("timing") in ("sung", "mapped") for l in sel),
            })
        i = j + 1
    return out


def join_text(lines: list[dict], lang: str | None) -> str:
    sep = "" if lang in ("ja", "zh", "yue", "th") else " "
    return sep.join(l["text"] for l in lines)


# ---------------------------------------------------------------- scoring
def collapse_loops(text: str) -> str:
    """Whisper's repeat loops ("誰 誰 誰 誰…"): keep at most 3 of the same token in a row."""
    out: list[str] = []
    for tok in text.split():
        if len(out) >= 3 and all(t == tok for t in out[-3:]):
            continue
        out.append(tok)
    return " ".join(out)


def norm_units(text: str, char: bool) -> list[str]:
    import unicodedata

    t = unicodedata.normalize("NFKC", text).lower()
    if char:
        try:  # Traditional and Simplified Chinese count as the same text
            import zhconv

            t = zhconv.convert(t, "zh-cn")
        except ImportError:
            pass
    t = "".join(c if (c.isalnum() or c.isspace() or c == "'") else " " for c in t)
    return list(t.replace(" ", "")) if char else t.split()


def edits(a: list[str], b: list[str]) -> int:
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
        prev = cur
    return prev[len(b)]


def score(pairs: list[tuple[str, str, str | None]]) -> dict:
    """WER for spaced languages, CER for CJK / Thai; pooled over all windows."""
    errs = units = 0
    char_units = word_units = 0
    for ref, hyp, lang in pairs:
        char = lang in CJK
        r, h = norm_units(ref, char), norm_units(collapse_loops(hyp), char)
        errs += edits(r, h)
        units += len(r)
        if char:
            char_units += len(r)
        else:
            word_units += len(r)
    metric = "CER" if char_units > word_units else "WER"
    return {"error": errs / units if units else None, "errors": errs, "units": units, "metric": metric}


# ---------------------------------------------------------------- model
class Env:
    def __init__(self, data: Path):
        os.environ.setdefault("HF_HOME", str(data / "hf-cache"))
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
        import torch
        from transformers import WhisperForConditionalGeneration, WhisperProcessor

        if not torch.cuda.is_available():
            raise SystemExit("No CUDA GPU found (training needs an NVIDIA GPU).")
        self.torch = torch
        self.dev = "cuda"
        emit("stage", stage="load", detail=f"Loading {BASE_MODEL} (downloaded once, about 1.6 GB)…")
        self.proc = WhisperProcessor.from_pretrained(BASE_MODEL)
        self.tok = self.proc.tokenizer
        self.model = WhisperForConditionalGeneration.from_pretrained(BASE_MODEL, dtype=torch.bfloat16).to(self.dev)
        self.model.config.use_cache = False
        self.sot = self.tok.convert_tokens_to_ids("<|startoftranscript|>")
        self.eot = self.tok.convert_tokens_to_ids("<|endoftext|>")
        self.transcribe = self.tok.convert_tokens_to_ids("<|transcribe|>")
        self.notimestamps = self.tok.convert_tokens_to_ids("<|notimestamps|>")
        self.ts0 = self.tok.convert_tokens_to_ids("<|0.00|>")
        from transformers.models.whisper.tokenization_whisper import LANGUAGES

        self.langs = {c: self.tok.convert_tokens_to_ids(f"<|{c}|>") for c in LANGUAGES}
        self.langs = {c: i for c, i in self.langs.items() if i is not None and i != self.tok.unk_token_id}

    def features(self, audio) -> "torch.Tensor":
        f = self.proc.feature_extractor(audio, sampling_rate=SR, return_tensors="pt").input_features
        return f.to(self.dev, dtype=self.torch.bfloat16)

    def detect_language(self, audio) -> str:
        torch = self.torch
        with torch.no_grad():
            logits = self.model(input_features=self.features(audio), decoder_input_ids=torch.tensor([[self.sot]], device=self.dev)).logits[0, -1]
        ids = list(self.langs.values())
        best = int(torch.argmax(logits[ids]))
        return list(self.langs.keys())[best]

    def labels(self, w: dict, lang: str, timestamps: bool) -> list[int]:
        ids = [self.langs.get(lang, self.langs["en"]), self.transcribe]
        if not timestamps:
            ids.append(self.notimestamps)
            ids += self.tok.encode(" " + join_text(w["lines"], lang).strip() if lang not in ("ja", "zh") else join_text(w["lines"], lang), add_special_tokens=False)
        else:
            ts = lambda ms: self.ts0 + max(0, min(1500, round(ms / 20)))  # noqa: E731 — 20 ms steps, ≤ 30 s
            for l in w["lines"]:
                text = l["text"] if lang in ("ja", "zh") else " " + l["text"]
                ids += [ts(l["start"])] + self.tok.encode(text, add_special_tokens=False) + [ts(l["end"])]
        return ids[:440] + [self.eot]

    def generate(self, audios: list, lang: str) -> list[str]:
        torch = self.torch
        feats = torch.cat([self.features(a) for a in audios])
        with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
            out = self.model.generate(input_features=feats, language=lang, task="transcribe", num_beams=1, max_new_tokens=220)
        return [t.strip() for t in self.tok.batch_decode(out, skip_special_tokens=True)]


def clip_audio(cache: dict, song: dict, a: float, b: float):
    k = song_id(song)
    if k not in cache:
        cache[k] = read_wav(song["audio"])
    x = cache[k]
    return x[int(a * SR / 1000) : int(b * SR / 1000)]


def evaluate(env: Env, ws: list[dict], songs: dict, audio: dict, langs: dict, batch: int = 8) -> dict:
    pairs = []
    by_lang: dict[str, list[dict]] = {}
    for w in ws:
        by_lang.setdefault(langs[w["song"]], []).append(w)
    for lang, group in by_lang.items():
        for i in range(0, len(group), batch):
            part = group[i : i + batch]
            hyps = env.generate([clip_audio(audio, songs[w["song"]], w["from"], w["to"]) for w in part], lang)
            pairs += [(join_text(w["lines"], lang), h, lang) for w, h in zip(part, hyps)]
    res = score(pairs)
    res["examples"] = [{"ref": r, "hyp": h} for r, h, _ in pairs[:3]]
    return res


def find_quantize(arg: str | None) -> Path | None:
    p = Path(arg) if arg else None
    return p if p and p.is_file() else None


def export_ggml(env: Env, data: Path, work: Path, quantize: Path | None) -> Path:
    """Merge the adapters, save a Hugging Face checkpoint, convert to ggml (f16), quantize to q5_0."""
    import numpy as np
    from huggingface_hub import snapshot_download
    from transformers import WhisperFeatureExtractor

    torch = env.torch
    emit("stage", stage="export", detail="Merging and converting the model for whisper.cpp…")
    merged_dir = work / "merged"
    if merged_dir.exists():
        shutil.rmtree(merged_dir)
    model = env.model.merge_and_unload()
    model = model.to(torch.float16)
    model.config.use_cache = True
    model.save_pretrained(merged_dir, safe_serialization=True)
    snap = Path(snapshot_download(BASE_MODEL, allow_patterns=["*.json", "*.txt"]))
    for f in snap.iterdir():
        if f.suffix in (".json", ".txt") and f.name not in ("config.json", "model.safetensors.index.json"):
            shutil.copy(f, merged_dir / f.name)
    # The converter reads mel filters from an openai-whisper checkout: write just that file.
    assets = work / "whisper-assets" / "whisper" / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    mels = {f"mel_{n}": WhisperFeatureExtractor(feature_size=n).mel_filters.T.astype("float32") for n in (80, 128)}
    np.savez_compressed(assets / "mel_filters.npz", **mels)
    conv = data / "trainer" / "convert-h5-to-ggml.py"
    if not conv.is_file():
        conv.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(CONVERTER_URL, conv)
    out_dir = work / "ggml"
    out_dir.mkdir(parents=True, exist_ok=True)
    r = subprocess.run([sys.executable, str(conv), str(merged_dir), str(work / "whisper-assets"), str(out_dir)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    f16 = out_dir / "ggml-model.bin"
    if r.returncode != 0 or not f16.is_file():
        raise RuntimeError(f"ggml conversion failed: {(r.stderr or r.stdout)[-800:]}")
    if quantize:
        q = out_dir / "ggml-model-q5_0.bin"
        r = subprocess.run([str(quantize), str(f16), str(q), "q5_0"], capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode == 0 and q.is_file():
            return q
        log(f"quantize failed, using f16: {(r.stderr or r.stdout)[-300:]}")
    return f16


# ---------------------------------------------------------------- commands
def stats(data: Path) -> dict:
    songs = load_songs(data)
    ws = [w for s in songs for w in windows(s)]
    secs = sum(sum(b - a for a, b in s.get("covered", [])) for s in songs) / 1000
    p = data / "split.json"
    held = set(json.loads(p.read_text(encoding="utf-8")).get("heldOut", [])) if p.is_file() else set()
    return {
        "songs": len(songs),
        "audioHours": round(secs / 3600, 3),
        "windows": len(ws),
        "windowHours": round(sum(w["to"] - w["from"] for w in ws) / 3_600_000, 3),
        "heldOut": len([s for s in songs if song_id(s) in held]),
    }


def run(args) -> int:
    t0 = time.time()
    data = Path(args.data)
    budget = args.max_hours * 3600
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    work = data / "runs" / stamp
    work.mkdir(parents=True, exist_ok=True)
    random.seed(0)

    songs = load_songs(data)
    if len(songs) < 2:
        emit("error", message=f"Need at least 2 songs with audio (have {len(songs)}).")
        return 2
    train_s, held_s = split_songs(songs, data)
    by_id = {song_id(s): s for s in songs}
    train_w = [w for s in train_s for w in windows(s)]
    eval_w = [w for s in held_s for w in windows(s)]
    if args.smoke:
        train_w, eval_w = train_w[:6], eval_w[:3]
    emit("stage", stage="prepare", detail=f"{len(train_s)} songs to learn from ({len(train_w)} clips), {len(held_s)} held out ({len(eval_w)} clips)")
    if not train_w or not eval_w:
        emit("error", message="Not enough lyrics lines with audio yet (need clips in both the training and held-out songs).")
        return 2

    env = Env(data)
    torch = env.torch
    audio: dict = {}
    langs_p = data / "langs.json"
    langs = json.loads(langs_p.read_text(encoding="utf-8")) if langs_p.is_file() else {}
    for s in songs:
        k = song_id(s)
        if s.get("lang") in env.langs:
            langs[k] = s["lang"]
        elif k not in langs:
            first = next((w for w in windows(s)), None)
            langs[k] = env.detect_language(clip_audio(audio, s, first["from"], first["to"])) if first else "en"
    langs_p.write_text(json.dumps(langs, ensure_ascii=False, indent=1), encoding="utf-8")

    emit("stage", stage="base-eval", detail=f"Measuring the original model on {len(eval_w)} held-out clips…")
    te = time.time()
    base = evaluate(env, eval_w, by_id, audio, langs)
    eval_s = time.time() - te
    emit("measure", which="original", **{k: v for k, v in base.items() if k != "examples"})

    # ---- LoRA
    from peft import LoraConfig, get_peft_model

    env.model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    lora = LoraConfig(r=32, lora_alpha=64, lora_dropout=0.05, bias="none", target_modules=["q_proj", "k_proj", "v_proj", "out_proj", "fc1", "fc2"])
    env.model = get_peft_model(env.model, lora)
    params = [p for p in env.model.parameters() if p.requires_grad]
    n_train = sum(p.numel() for p in params)
    bs = 4
    accum = 2
    epochs = 1 if args.smoke else max(2, min(6, math.ceil(3000 / max(1, len(train_w)))))
    steps_planned = max(1, math.ceil(len(train_w) * epochs / (bs * accum)))
    if args.smoke:
        steps_planned = min(steps_planned, 3)
    opt = torch.optim.AdamW(params, lr=1e-4 if not args.smoke else 5e-5, weight_decay=0.01)
    warm = max(1, steps_planned // 10)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / steps_planned))))
    train_budget = budget - (time.time() - t0) - eval_s * 1.2 - RESERVE_S
    emit("stage", stage="train", detail=f"Training {n_train / 1e6:.1f} M adapter weights on {len(train_w)} clips, {epochs} epochs (≈ {steps_planned} steps)", steps=steps_planned)
    if train_budget <= 60:
        emit("error", message="The time limit is too short to train.")
        return 2

    env.model.train()
    step = 0
    tstart = time.time()
    losses: list[float] = []
    stopped = "done"
    for ep in range(epochs):
        order = train_w[:]
        random.shuffle(order)
        for i in range(0, len(order), bs):
            part = order[i : i + bs]
            feats, labels = [], []
            for w in part:
                a = clip_audio(audio, by_id[w["song"]], w["from"], w["to"])
                gain = 10 ** (random.uniform(-6, 3) / 20)  # loudness differs between players / masters
                feats.append(env.features(a * gain))
                ts = w["timestamps"] and random.random() < 0.5
                labels.append(env.labels(w, langs[w["song"]], ts))
            width = max(len(l) for l in labels)
            lab = torch.full((len(labels), width), -100, dtype=torch.long)
            for k, l in enumerate(labels):
                lab[k, : len(l)] = torch.tensor(l)
            with torch.autocast("cuda", dtype=torch.bfloat16):
                out = env.model(input_features=torch.cat(feats), labels=lab.to(env.dev))
            (out.loss / accum).backward()
            losses.append(out.loss.item())
            if (i // bs + 1) % accum == 0 or i + bs >= len(order):
                torch.nn.utils.clip_grad_norm_(params, 1.0)
                opt.step()
                sched.step()
                opt.zero_grad(set_to_none=True)
                step += 1
                el = time.time() - tstart
                emit("progress", step=step, steps=steps_planned, epoch=ep + 1, epochs=epochs, loss=round(sum(losses[-20:]) / len(losses[-20:]), 4), elapsedS=round(time.time() - t0), etaS=round(el / step * max(0, steps_planned - step)))
                if step >= steps_planned:
                    break
                if time.time() - tstart > train_budget:
                    stopped = "time limit"
                    break
        if step >= steps_planned or stopped != "done":
            break

    env.model.eval()
    emit("stage", stage="eval", detail="Measuring the tuned model on the held-out songs…")
    tuned = evaluate(env, eval_w, by_id, audio, langs)
    emit("measure", which="tuned", **{k: v for k, v in tuned.items() if k != "examples"})

    better = base["error"] is not None and tuned["error"] is not None and tuned["error"] < base["error"] * 0.99
    trustworthy = len(held_s) >= MIN_HELD_SONGS and (base["units"] or 0) >= MIN_HELD_UNITS
    adopt = better and trustworthy and not args.smoke
    result = {
        "at": datetime.now(timezone.utc).isoformat(),
        "smoke": bool(args.smoke),
        "base": BASE_MODEL,
        "songs": len(songs),
        "trainSongs": len(train_s),
        "heldOutSongs": len(held_s),
        "trainClips": len(train_w),
        "heldOutClips": len(eval_w),
        "steps": step,
        "stopped": stopped,
        "hours": round((time.time() - t0) / 3600, 3),
        "metric": base["metric"],
        "baseError": base["error"],
        "tunedError": tuned["error"],
        "better": better,
        "enoughToJudge": trustworthy,
        "adopted": False,
        "examples": {"original": base["examples"], "tuned": tuned["examples"]},
    }
    if adopt or args.export:
        try:
            model_file = export_ggml(env, data, work, find_quantize(args.quantize))
            result["exported"] = str(model_file)
            if adopt:
                models = data / "models"
                models.mkdir(parents=True, exist_ok=True)
                dest = models / f"mine-{stamp}{model_file.suffix}"
                shutil.copy(model_file, dest)
                current = {k: result[k] for k in ("at", "base", "songs", "trainSongs", "heldOutSongs", "metric", "baseError", "tunedError")}
                current.update({"path": str(dest), "adopted": True})
                tmp = models / "current.json.tmp"
                tmp.write_text(json.dumps(current, ensure_ascii=False, indent=1), encoding="utf-8")
                os.replace(tmp, models / "current.json")
                result["adopted"] = True
                result["model"] = str(dest)
        except Exception as e:  # keep the measured result even when the export breaks
            result["exportError"] = str(e)
    if not args.keep_work:
        shutil.rmtree(work / "merged", ignore_errors=True)
    (work / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    (data / "last-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    emit("result", **result)
    return 0


def main() -> int:
    for f in (sys.stdout, sys.stderr):  # JSON lines carry song titles in any script
        f.reconfigure(encoding="utf-8", errors="replace")
    ap =argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    st = sub.add_parser("stats")
    st.add_argument("--data", required=True)
    r = sub.add_parser("run")
    r.add_argument("--data", required=True)
    r.add_argument("--max-hours", type=float, default=5.0)
    r.add_argument("--smoke", action="store_true", help="a few steps on a few clips, to check the pipeline (never adopted)")
    r.add_argument("--export", action="store_true", help="convert to ggml even when the model isn't adopted")
    r.add_argument("--keep-work", action="store_true")
    r.add_argument("--quantize", help="path to whisper-quantize.exe")
    a = ap.parse_args()
    if a.cmd == "stats":
        emit("stats", **stats(Path(a.data)))
        return 0
    try:
        return run(a)
    except SystemExit as e:
        emit("error", message=str(e))
        return 2
    except Exception as e:
        import traceback

        emit("error", message=f"{type(e).__name__}: {e}", trace=traceback.format_exc()[-2000:])
        return 1


if __name__ == "__main__":
    sys.exit(main())
