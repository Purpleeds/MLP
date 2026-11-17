// Small persistent key-value store: Tauri plugin-store file in the app, localStorage in mock mode.
import { isTauri } from "../platform";

export interface Kv<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  entries(): Promise<[string, T][]>;
  clear(): Promise<void>;
}

export function createKv<T>(file: string): Kv<T> {
  if (isTauri()) {
    type S = Awaited<ReturnType<typeof import("@tauri-apps/plugin-store").load>>;
    let store: Promise<S> | null = null;
    const s = () =>
      (store ??= import("@tauri-apps/plugin-store").then(({ load }) => load(file, { defaults: {}, autoSave: 500 })));
    return {
      get: async (k) => (await s()).get<T>(k),
      set: async (k, v) => (await s()).set(k, v),
      delete: async (k) => void (await (await s()).delete(k)),
      entries: async () => (await s()).entries<T>(),
      clear: async () => (await s()).clear(),
    };
  }
  const prefix = `mlp.${file}.`;
  return {
    get: async (k) => {
      try {
        const v = localStorage.getItem(prefix + k);
        return v == null ? undefined : (JSON.parse(v) as T);
      } catch {
        return undefined;
      }
    },
    set: async (k, v) => {
      try {
        localStorage.setItem(prefix + k, JSON.stringify(v));
      } catch {
        /* quota / unavailable */
      }
    },
    delete: async (k) => {
      try {
        localStorage.removeItem(prefix + k);
      } catch {
        /* unavailable */
      }
    },
    entries: async () => {
      const out: [string, T][] = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k?.startsWith(prefix)) out.push([k.slice(prefix.length), JSON.parse(localStorage.getItem(k)!) as T]);
        }
      } catch {
        /* unavailable */
      }
      return out;
    },
    clear: async () => {
      try {
        for (const k of Object.keys(localStorage)) if (k.startsWith(prefix)) localStorage.removeItem(k);
      } catch {
        /* unavailable */
      }
    },
  };
}
