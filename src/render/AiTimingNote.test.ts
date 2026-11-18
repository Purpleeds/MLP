import { describe, expect, it } from "vitest";
import { timingNote } from "./AiTimingNote";
import type { SyncStatus } from "../core/ai/engine";

const st = (p: Partial<SyncStatus> = {}): SyncStatus => ({ phase: "listening", detail: "Listening…", aligned: 0, total: 20, ...p });
const on = { autoSync: true, listen: true };

describe("plain lyrics timing note", () => {
  it("offers to turn AI timing on when listening is off, with the download size", () => {
    const n = timingNote({ autoSync: true, listen: false }, st({ phase: "off", need: "turn-on", download: { ids: ["mms-aligner"], mb: 317, busy: false } }), false);
    expect(n.button).toBe("Time with AI");
    expect(n.text).toMatch(/aren't timed\. Turn on AI listening to time them \(a one-time 317 MB download\)/);
  });

  it("offers it when auto-sync is off too, even before the engine reported anything", () => {
    expect(timingNote({ autoSync: false, listen: true }, st({ phase: "off" }), false).button).toBe("Time with AI");
  });

  it("offers the download when listening is on but the model is missing", () => {
    const n = timingNote(on, st({ phase: "off", need: "download", download: { ids: ["mms-aligner"], mb: 317, busy: false } }), false);
    expect(n.button).toBe("Time with AI");
    expect(n.text).toContain("317 MB");
  });

  it("shows progress while setting up, then a retry after a failed download", () => {
    expect(timingNote({ autoSync: true, listen: false }, st({ phase: "off", need: "download", detail: "Downloading Auto-sync… 42 %" }), true)).toEqual({ text: "Downloading Auto-sync… 42 %" });
    expect(timingNote(on, st({ phase: "off", need: "download", detail: "Downloading…", download: { ids: ["x"], mb: 1, busy: true } }), false).button).toBeUndefined();
    expect(timingNote(on, st({ phase: "error", need: "download", detail: "Download failed: offline" }), false)).toEqual({ text: "Download failed: offline", button: "Try again" });
  });

  it("says it's working (no button) once everything is on", () => {
    const n = timingNote(on, st(), false);
    expect(n.button).toBeUndefined();
    expect(n.text).toMatch(/timing them with AI/);
    expect(timingNote(on, st({ phase: "done" }), false).text).toMatch(/couldn't line them up/);
  });
});
