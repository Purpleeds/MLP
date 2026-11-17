// Upgrade 10: per-app correction history (offset-learn.json) and the learned default offsets.
import { useEffect, useState } from "react";
import { createKv } from "../storage/kv";
import { isTauri, platform } from "../platform";
import { getSettings } from "../settings/store";
import { addSample, learnedOffset, type OffsetSample, type SourceKind } from "./learn";

const store = createKv<OffsetSample[]>("offset-learn.json");
const cache = new Map<string, number | null>();

/** Remember a per-song correction for its app (called whenever the per-song offset changes). */
export async function recordCorrection(source: SourceKind, song: string, offsetMs: number) {
  if (source === "mock") return;
  const next = addSample((await store.get(source)) ?? [], song, offsetMs);
  await store.set(source, next);
  cache.set(source, learnedOffset(next));
  if (isTauri()) await platform.emit("offset-learned", source);
}

/** Learned default offset for songs from this app (0 when off / nothing learned yet). */
export async function learnedFor(source: SourceKind): Promise<number> {
  if (!getSettings().timing.learnOffsets) return 0;
  if (!cache.has(source)) cache.set(source, learnedOffset((await store.get(source)) ?? []));
  return cache.get(source) ?? 0;
}

/** Settings: what has been learned so far, per app. */
export async function learnedSummary(): Promise<{ source: string; offset: number | null; songs: number }[]> {
  return (await store.entries()).map(([source, list]) => ({ source, offset: learnedOffset(list), songs: list.filter((x) => x.offset !== 0).length }));
}

export const forgetLearned = async () => {
  await store.clear();
  cache.clear();
  if (isTauri()) await platform.emit("offset-learned", "*");
};

/** React: learned default for the current app, updated live. */
export function useLearnedOffset(source: SourceKind | undefined): number {
  const [v, setV] = useState(0);
  const enabled = getSettings().timing.learnOffsets;
  useEffect(() => {
    if (!source) return;
    let alive = true;
    const load = () => void learnedFor(source).then((x) => alive && setV(x));
    load();
    const off = platform.on<string>("offset-learned", (s) => {
      cache.delete(source);
      if (s === source || s === "*") load();
    });
    return () => {
      alive = false;
      void off.then((f) => f());
    };
  }, [source, enabled]);
  return enabled ? v : 0;
}
