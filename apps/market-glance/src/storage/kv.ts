import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

/**
 * SDK key-value store (`bridge.getLocalStorage`/`setLocalStorage`) with a
 * synchronous mirror for the rest of the app and the phone page.
 *
 * Plain `localStorage` does not survive in the packaged .ehpk WebView (seen
 * three times across Quietglass apps: Pulse, amap-hud, even-card-platform);
 * the SDK KV is the only durable store. Reads stay synchronous because the
 * draw path and the phone page are synchronous: `init` hydrates the cache
 * from the KV once at boot, every write mirrors into it and is persisted
 * fire-and-forget. KV failures are silent by design and fall back to
 * `localStorage` in dev, which behaves like the old code.
 */
const cache = new Map<string, string>();
const pending = new Set<string>();
let bridgeRef: EvenAppBridge | null = null;

async function safeGet(key: string): Promise<string | null> {
  try {
    const raw = await bridgeRef?.getLocalStorage(key);
    return typeof raw === "string" && raw !== "" ? raw : null;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  const bridge = bridgeRef;
  if (!bridge) return;
  try {
    void Promise.resolve(bridge.setLocalStorage(key, value)).catch(() => undefined);
  } catch {
    /* KV unavailable (dev/test bridge): the mirror still holds the value */
  }
}

/** Hydrate the cache; keys are the app's storage keys incl. the locale key. */
async function init(bridge: EvenAppBridge, keys: readonly string[]): Promise<void> {
  bridgeRef = bridge;
  const remote = await Promise.all(keys.map((key) => safeGet(key)));
  keys.forEach((key, index) => {
    const value = remote[index];
    if (value !== null && value !== undefined) {
      // A write made before init finished (e.g. ?lang= override) always wins.
      if (pending.has(key)) safeSet(key, cache.get(key) ?? value);
      else cache.set(key, value);
    }
  });
}

function get(key: string): string | null {
  const local = cache.get(key);
  if (local !== undefined) return local === "" ? null : local;
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function set(key: string, value: string): void {
  cache.set(key, value);
  pending.add(key);
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* dev mirror only; the SDK KV is the durable copy */
  }
  safeSet(key, value);
}

function remove(key: string): void {
  set(key, "");
}

export const appStore = { init, get, set, remove };
