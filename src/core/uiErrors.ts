// UI crash log: errors that broke part of a window (caught by an error boundary) or escaped as
// uncaught errors. Logged to the app's stdout and kept (newest first, a few only) in ui-errors.json
// in the app data folder, so a crash that only happens "sometimes" can be read back later.
// Local only: nothing is uploaded.
import { platform } from "./platform";
import { createKv } from "./storage/kv";

export interface UiError {
  at: number;
  /** which window and part, e.g. "settings/page:ai" */
  where: string;
  message: string;
  stack?: string;
  /** React component stack, when a boundary caught it */
  components?: string;
  /** how many times this same error was seen in a row */
  count: number;
}

export const MAX_UI_ERRORS = 20;
const CAP = 4000;

/** Normalize anything thrown into a message + stack. */
export function describeError(e: unknown): { message: string; stack?: string } {
  if (e instanceof Error) return { message: `${e.name}: ${e.message}`, stack: e.stack?.slice(0, CAP) };
  if (typeof e === "string") return { message: e };
  try {
    return { message: JSON.stringify(e) ?? String(e) };
  } catch {
    return { message: String(e) };
  }
}

/** Add an entry to the log (newest first); a repeat of the newest entry bumps its count instead. */
export function pushUiError(list: UiError[], e: Omit<UiError, "count">, max = MAX_UI_ERRORS): UiError[] {
  const top = list[0];
  if (top && top.where === e.where && top.message === e.message) return [{ ...top, at: e.at, count: top.count + 1 }, ...list.slice(1)];
  return [{ ...e, components: e.components?.slice(0, CAP), count: 1 }, ...list].slice(0, max);
}

/** Text for "Copy details". */
export function formatUiError(e: Pick<UiError, "where" | "message" | "stack" | "components"> & { at?: number }): string {
  return [`MLP ${e.where}${e.at ? ` · ${new Date(e.at).toISOString()}` : ""}`, e.message, e.stack ?? "", e.components ? `Components:${e.components}` : ""]
    .filter(Boolean)
    .join("\n");
}

const kv = createKv<UiError[]>("ui-errors.json");
let chain: Promise<void> = Promise.resolve();

export function reportUiError(where: string, error: unknown, components?: string): void {
  const d = describeError(error);
  platform.log(`[error] ${where}: ${d.message}`);
  console.error(`[${where}]`, error);
  // Serialized so two errors in a row don't overwrite each other.
  chain = chain.then(async () => kv.set("log", pushUiError((await kv.get("log")) ?? [], { at: Date.now(), where, ...d, components }))).catch(() => undefined);
}

export const readUiErrors = async (): Promise<UiError[]> => (await kv.get("log").catch(() => undefined)) ?? [];

/** Log uncaught errors and rejected promises of this window (they don't unmount React, but help explain a crash). */
export function logUncaughtErrors(windowName: string): void {
  window.addEventListener("error", (e) => reportUiError(`${windowName}/uncaught`, e.error ?? e.message));
  // Rejected promises are mostly network hiccups: stdout only, so they don't push real crashes out of the file.
  window.addEventListener("unhandledrejection", (e) => platform.log(`[promise] ${windowName}: ${describeError(e.reason).message}`));
}
