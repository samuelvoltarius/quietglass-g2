import { resetGestureDedupe } from "../src/input/gestures";

/**
 * A fake Even bridge that records what the app puts on the glasses: the text
 * of the three text containers, the kind of the current page (text or
 * cockpit), and every image tile written. Shared by the tests that boot the
 * real app.
 */

export interface FakeSource { id: string; name: string; url: string }

export const NAS: FakeSource[] = [{ id: "s1", name: "nas", url: "https://nas.test/status" }];

export interface FakeOptions {
  createHangs?: boolean;
  kv?: Map<string, string>;
  /** Called for every image write; may return a promise to hold the write. */
  onImage?: (containerID: number | undefined) => Promise<void> | void;
}

interface PageLike { textObject?: { containerID?: number; content?: string }[]; imageObject?: unknown[]; menuObject?: unknown }

export function fakeBridge(sources: FakeSource[] = NAS, options: FakeOptions = {}) {
  const kv = options.kv ?? new Map<string, string>();
  let onEvent: ((event: unknown) => void) | undefined;
  const state = {
    creates: 0, rebuilds: 0, shutdowns: 0, shutdownFails: false, confirm: true, modes: [] as (number | undefined)[],
    header: "", body: "", footer: "", draws: 0,
    /** "text" or "cockpit": what the last created/rebuilt page was. */
    kind: "text" as "text" | "cockpit",
    /** Image writes so far, and which container got how many. */
    images: 0, byTile: new Map<number, number>(),
    pages: [] as PageLike[],
  };
  const record = (id: number | undefined, content: string | undefined): void => {
    if (id === 1) state.header = content ?? "";
    if (id === 2) { state.body = content ?? ""; state.draws += 1; }
    if (id === 3) state.footer = content ?? "";
  };
  const page = (p: PageLike): void => {
    state.kind = (p.imageObject?.length ?? 0) > 0 ? "cockpit" : "text";
    for (const text of p.textObject ?? []) record(text.containerID, text.content);
  };
  const bridge = {
    getLocalStorage: async (key: string) => key.startsWith("quietglass.statusglass.ui") ? kv.get(key) ?? "" : JSON.stringify({ sources, pollSeconds: 30, invertScroll: false }),
    setLocalStorage: async (key: string, value: string) => { kv.set(key, value); return true; },
    rebuildPageContainer: async (p: PageLike) => { state.rebuilds += 1; page(p); return true; },
    createStartUpPageContainer: async (p: PageLike) => {
      state.creates += 1;
      state.pages.push(p);
      if (options.createHangs) return new Promise<number>(() => undefined);
      page(p);
      return 0;
    },
    updateImageRawData: async (update: { containerID?: number }) => {
      await options.onImage?.(update.containerID);
      state.images += 1;
      if (update.containerID !== undefined) state.byTile.set(update.containerID, (state.byTile.get(update.containerID) ?? 0) + 1);
      return "success";
    },
    textContainerUpgrade: async (upgrade: { containerID?: number; content?: string }) => {
      record(upgrade.containerID, upgrade.content);
      return true;
    },
    shutDownPageContainer: (mode?: number): Promise<boolean> => {
      state.shutdowns += 1;
      state.modes.push(mode);
      return state.shutdownFails ? Promise.reject(new Error("page already gone")) : Promise.resolve(state.confirm);
    },
    onEvenHubEvent: (callback: (event: unknown) => void) => { onEvent = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, state, kv,
    ready: () => onEvent !== undefined,
    gesture: (eventType: number, dedupe = true) => { if (dedupe) resetGestureDedupe(); onEvent?.({ sysEvent: { eventType, eventSource: 1 } }); },
  };
}

export const CLICK = 0;
export const SCROLL_UP = 1;
export const SCROLL_DOWN = 2;
export const DOUBLE_TAP = 3;
export const HOLD = 9;

/** Just enough DOM for the phone page: assigning innerHTML throws away every element, as a real rebuild would. */
export class FakeElement {
  value = "";
  checked = false;
  textContent = "";
  innerHTML = "";
  readonly dataset: Record<string, string> = {};
  readonly #listeners = new Map<string, ((event: unknown) => void)[]>();
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  fire(type: string): void { for (const listener of this.#listeners.get(type) ?? []) listener({ target: this }); }
}

export class FakeRoot {
  #html = "";
  readonly elements = new Map<string, FakeElement>();
  removeButtons: FakeElement[] | null = null;
  set innerHTML(html: string) { this.#html = html; this.removeButtons = null; }
  get innerHTML(): string { return this.#html; }
  querySelector(selector: string): FakeElement {
    let element = this.elements.get(selector);
    if (!element) { element = new FakeElement(); this.elements.set(selector, element); }
    return element;
  }
  querySelectorAll(selector: string): FakeElement[] {
    if (selector !== ".remove") return [];
    // Built from the markup, and the same elements until the next rebuild.
    if (this.removeButtons) return this.removeButtons;
    this.removeButtons = [...this.innerHTML.matchAll(/class="remove" data-id="([^"]+)"/g)].map((match) => {
      const button = new FakeElement();
      button.dataset["id"] = match[1] ?? "";
      return button;
    });
    return this.removeButtons;
  }
}
