import type { Lang } from "../probe/results";
import type { DeviceWanted, ModelId, WasmSource } from "../probe/whisper";

/**
 * Phone page: language, card A (platform speech recognition), card B (Whisper
 * on the glasses microphone), each with a Start button and a results table,
 * and "Copy results" as plain text.
 */

export interface Settings {
  lang: Lang;
  model: ModelId;
  device: DeviceWanted;
  wasm: WasmSource;
}

export interface PhoneHandlers {
  readonly settings: Settings;
  onSettings(next: Settings): void;
  startA(): void;
  startB(): void;
  promptSeen(answer: "yes" | "no"): void;
  copyText(): string;
}

export interface PhoneUi {
  statusA(text: string): void;
  statusB(text: string): void;
  busyA(busy: boolean): void;
  busyB(busy: boolean): void;
  tableA(rows: Array<[string, string]>): void;
  tableB(rows: Array<[string, string]>): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, children: Array<Node | string> = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function select<T extends string>(label: string, value: T, options: Array<[T, string]>, onChange: (v: T) => void): HTMLElement {
  const sel = el("select");
  for (const [v, text] of options) sel.append(el("option", { value: v, textContent: text, selected: v === value }));
  sel.addEventListener("change", () => onChange(sel.value as T));
  return el("div", {}, [el("label", { textContent: label }), sel]);
}

function fillTable(table: HTMLTableElement, rows: Array<[string, string]>): void {
  table.replaceChildren(...rows.map(([k, v]) => el("tr", {}, [el("td", { textContent: k }), el("td", { textContent: v })])));
}

export function mountPhoneUi(root: HTMLElement, h: PhoneHandlers): PhoneUi {
  const settings = { ...h.settings };
  const change = (): void => h.onSettings({ ...settings });

  const statusA = el("p", { className: "hint", textContent: "Not run yet." });
  const statusB = el("p", { className: "hint", textContent: "Not run yet." });
  const tableA = el("table", { className: "keys" });
  const tableB = el("table", { className: "keys" });
  const startA = el("button", { textContent: "Start test A" });
  const startB = el("button", { textContent: "Start test B" });
  startA.addEventListener("click", () => h.startA());
  startB.addEventListener("click", () => h.startB());

  const yes = el("button", { className: "remove", textContent: "Prompt seen: yes" });
  const no = el("button", { className: "remove", textContent: "Prompt seen: no" });
  yes.addEventListener("click", () => h.promptSeen("yes"));
  no.addEventListener("click", () => h.promptSeen("no"));

  const copyOut = el("textarea", { rows: 8, readOnly: true });
  copyOut.style.display = "none";
  const copy = el("button", { textContent: "Copy results" });
  const copyHint = el("p", { className: "hint", textContent: "" });
  copy.addEventListener("click", () => {
    const text = h.copyText();
    copyOut.value = text;
    copyOut.style.display = "block";
    copyOut.select();
    const done = (how: string): void => { copyHint.textContent = how; };
    try {
      void navigator.clipboard.writeText(text).then(() => done("Copied."), () => done("Clipboard blocked – text selected below, copy it by hand."));
    } catch {
      done("Clipboard not available – text selected below, copy it by hand.");
    }
  });

  root.replaceChildren(
    el("header", { className: "brand" }, [
      el("div", { className: "brand-mark", textContent: "Quietglass / Test" }),
      el("h1", { textContent: "Speech Probe" }),
      el("p", { className: "hint", textContent: "Private test: can voice apps work without our own Whisper server?" }),
    ]),
    el("section", { className: "card" }, [
      select<Lang>("Language (both tests)", settings.lang, [["de", "Deutsch (de)"], ["en", "English (en)"]], (v) => { settings.lang = v; change(); }),
    ]),
    el("section", { className: "card" }, [
      el("h2", { textContent: "A · Platform speech recognition (phone mic)" }),
      el("p", { className: "hint", textContent: "Press Start, then speak one sentence. If iOS asks for microphone or speech permission, allow it and note below whether a prompt appeared. If the Even app closes, that is the answer too (the step log keeps \"testAStart\")." }),
      startA,
      statusA,
      el("div", { className: "row" }, [yes, no]),
      tableA,
    ]),
    el("section", { className: "card" }, [
      el("h2", { textContent: "B · Whisper in the WebView (glasses mic, 5 s)" }),
      select<ModelId>("Model", settings.model, [["whisper-tiny", "whisper-tiny (~41 MB WASM q8, ~122 MB WebGPU)"], ["whisper-base", "whisper-base (~77 MB WASM q8, more on WebGPU)"]], (v) => { settings.model = v; change(); }),
      select<DeviceWanted>("Backend", settings.device, [["auto", "auto (WebGPU if available, else WASM)"], ["webgpu", "WebGPU only"], ["wasm", "WASM only"]], (v) => { settings.device = v; change(); }),
      select<WasmSource>("ONNX runtime files", settings.wasm, [["bundled", "from the app package (no CDN)"], ["cdn", "from cdn.jsdelivr.net (transformers.js default)"]], (v) => { settings.wasm = v; change(); }),
      el("p", { className: "hint", textContent: "The runtime source is fixed by the first test B of an app run; reopen the app to switch. Start records 5 s from the glasses microphone (or tap Test B on the glasses), then transcribes on the phone. The first run downloads the model; run it twice for warm numbers." }),
      startB,
      statusB,
      tableB,
    ]),
    el("section", { className: "card" }, [copy, copyHint, copyOut]),
  );

  return {
    statusA: (t) => { statusA.textContent = t; },
    statusB: (t) => { statusB.textContent = t; },
    busyA: (b) => { startA.disabled = b; startA.textContent = b ? "Running…" : "Start test A"; },
    busyB: (b) => { startB.disabled = b; startB.textContent = b ? "Running…" : "Start test B"; },
    tableA: (rows) => fillTable(tableA, rows),
    tableB: (rows) => fillTable(tableB, rows),
  };
}
