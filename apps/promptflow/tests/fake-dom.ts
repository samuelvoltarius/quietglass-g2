/**
 * A minimal stand-in for the phone page's DOM, so the companion UI can be
 * exercised without a browser or an extra test dependency.
 *
 * Setting `innerHTML` parses the opening tags of form controls and buttons into
 * fake elements; `querySelector("#id")`, `querySelectorAll(".class")` and
 * `querySelectorAll('tag[name="x"]')` find them. Elements are rebuilt on every
 * render, exactly like the real page, so listeners from a previous render are
 * gone afterwards.
 */

export interface FakeElement {
  readonly tag: string;
  readonly id: string;
  readonly classes: readonly string[];
  readonly name: string;
  readonly dataset: Record<string, string>;
  value: string;
  checked: boolean;
  textContent: string;
  addEventListener(type: string, listener: (event: { target: FakeElement }) => void): void;
  /** Fires the listeners for `type`, as a user interaction would. */
  fire(type: string): void;
}

export interface FakeRoot {
  innerHTML: string;
  /** How many times the page was rendered. */
  readonly renders: number;
  querySelector(selector: string): FakeElement | null;
  querySelectorAll(selector: string): FakeElement[];
  /** Like querySelector, but fails loudly instead of returning null. */
  get(selector: string): FakeElement;
}

const TAG = /<(input|textarea|select|button|output|option)\b([^>]*)>/gi;
const ATTR = /([\w-]+)(?:\s*=\s*"([^"]*)")?/g;

function unescape(text: string): string {
  return text
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function element(tag: string, attrs: Map<string, string>): FakeElement {
  const listeners = new Map<string, Array<(event: { target: FakeElement }) => void>>();
  const dataset: Record<string, string> = {};
  for (const [key, value] of attrs) {
    if (key.startsWith("data-")) dataset[key.slice(5)] = value;
  }
  const el: FakeElement = {
    tag,
    id: attrs.get("id") ?? "",
    classes: (attrs.get("class") ?? "").split(/\s+/).filter(Boolean),
    name: attrs.get("name") ?? "",
    dataset,
    value: attrs.get("value") ?? "",
    checked: attrs.has("checked"),
    textContent: "",
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    fire(type) {
      for (const listener of listeners.get(type) ?? []) listener({ target: el });
    },
  };
  return el;
}

export function fakeRoot(): FakeRoot {
  let html = "";
  let renders = 0;
  let elements: FakeElement[] = [];

  const parse = (source: string): FakeElement[] => {
    const found: FakeElement[] = [];
    for (const match of source.matchAll(TAG)) {
      const attrs = new Map<string, string>();
      for (const attr of (match[2] ?? "").matchAll(ATTR)) {
        if (attr[1]) attrs.set(attr[1].toLowerCase(), unescape(attr[2] ?? ""));
      }
      found.push(element((match[1] ?? "").toLowerCase(), attrs));
    }
    return found;
  };

  const matches = (el: FakeElement, selector: string): boolean => {
    if (selector.startsWith("#")) return el.id === selector.slice(1);
    if (selector.startsWith(".")) return el.classes.includes(selector.slice(1));
    const named = /^(\w+)\[name="([^"]+)"\]$/.exec(selector);
    if (named) return el.tag === named[1] && el.name === named[2];
    return el.tag === selector;
  };

  const root: FakeRoot = {
    get innerHTML() { return html; },
    set innerHTML(value: string) {
      html = value;
      renders++;
      elements = parse(value);
    },
    get renders() { return renders; },
    querySelector: (selector) => elements.find((el) => matches(el, selector)) ?? null,
    querySelectorAll: (selector) => elements.filter((el) => matches(el, selector)),
    get(selector) {
      const el = root.querySelector(selector);
      if (!el) throw new Error("no element for " + selector);
      return el;
    },
  };
  return root;
}
