// Side-effect module: makes the browser-shaped store loadable in a CLI process.
//
// `src/lib/store.ts` persists through `createJSONStorage(() => localStorage)`,
// which zustand resolves once, at store creation. Under Node there is no
// `localStorage`, so the resolution fails and every subsequent `set` — and the
// bot journal writes one per order — prints "the given storage is currently
// unavailable". A single backtest produces a couple of those; a parameter sweep
// produces thousands, on stderr, in the middle of the report.
//
// Rather than reach into the shared store, the CLI entry points install a
// throwaway in-memory storage before anything imports it. Nothing reads it back:
// the point is that persistence lands somewhere harmless instead of throwing.
//
// Import this FIRST in a headless entry point — ESM evaluates imported modules
// in source order, so it only wins the race if it is at the top.

interface MinimalStorage {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
}

export function createMemoryStorage(): MinimalStorage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    getItem: (key) => map.get(String(key)) ?? null,
    setItem: (key, value) => void map.set(String(key), String(value)),
    removeItem: (key) => void map.delete(String(key)),
    clear: () => map.clear(),
    key: (index) => Array.from(map.keys())[index] ?? null,
  };
}

/** True when a storage was installed, false when one already existed. */
export function installHeadlessStorage(): boolean {
  const global = globalThis as Record<string, unknown>;
  if (global.localStorage !== undefined) return false;
  global.localStorage = createMemoryStorage();
  return true;
}

installHeadlessStorage();
