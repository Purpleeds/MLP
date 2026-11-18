# Train on my songs

An on-PC LoRA fine-tune of Whisper large-v3-turbo on the songs MLP has heard. The app runs all of
this from Settings → AI → Train on my songs; this file is for running it by hand.

## Data

With "Save audio of songs with synced lyrics" on (and "Listen to the player" on), every song that has
synced lyrics (LRCLIB, AMLL, your own synced LRC, auto-synced plain lyrics, or AI lyrics you fixed by
hand) is kept in the training folder when the song changes:

```
<training folder>/songs/<title> - <artist> [id]/audio.wav   16 kHz mono, song time
                                               /song.json   lines (start/end ms, text, trusted, timing), covered ranges
```

The training folder defaults to `X:\MLP training` on the roomiest fixed drive that isn't the system
drive (else `<app data>\ai\training`). Playing a song again fills in parts that weren't captured.
Line times come from auto-sync when it lined the line up with the singing (`timing: "sung"`), from its
time map (`"mapped"`), or from the lyrics plus your offsets (`"lyrics"`). Only `sung` / `mapped`
windows teach timestamps.

About 2 MB per minute; a fine-tune starts to help after roughly 2 hours (30+ songs).

## Environment (once, ~5 GB)

```
uv venv --python 3.12 "<folder>\env"
uv pip install --python "<folder>\env\Scripts\python.exe" torch --index-url https://download.pytorch.org/whl/cu128
uv pip install --python "<folder>\env\Scripts\python.exe" -r training/requirements.txt
```

CUDA 12.8 wheels are needed for RTX 50-series (Blackwell) GPUs.

## Run

```
<env>\Scripts\python.exe training/mlp_train.py stats --data "<folder>"
<env>\Scripts\python.exe training/mlp_train.py run --data "<folder>" --max-hours 5 --quantize <whisper engine>\whisper-quantize.exe
```

`--smoke` = a few steps on a few clips to check the pipeline (never adopted); `--export` converts
even when not adopted.

What a run does:

1. Splits songs into training and held-out (about 20 %, by a hash of the song; `split.json` keeps a
   song on its side forever, so test songs never leak into training).
2. Cuts ≤ 28 s windows of whole trusted lines (Bopomofo humming and untrusted AI lines break windows).
3. Measures the original model on the held-out windows (WER, or CER for CJK / Thai; Traditional and
   Simplified Chinese count as the same; repeat loops are collapsed).
4. Trains LoRA (r 32, attention + MLP of encoder and decoder, bf16, gradient checkpointing) until the
   planned steps or the time budget (`--max-hours` minus 15 min reserve and the measuring time).
5. Measures again. The tuned model is adopted only when it's at least 1 % better **and** there are at
   least 3 held-out songs / 300 reference units; otherwise the original stays.
6. Adopted: merge → Hugging Face checkpoint → ggml (whisper.cpp `convert-h5-to-ggml.py`, pinned to
   b5454) → q5_0 → `models/mine-<date>.bin` + `models/current.json`. The app then writes AI lyrics with
   it (setting "use it for AI lyrics"); if it fails to load, the app falls back to the original model.

Progress is printed as JSON lines (`stage`, `progress`, `measure`, `result`, `error`, `log`);
`last-result.json` holds the last run's numbers.
