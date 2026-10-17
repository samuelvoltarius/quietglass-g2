import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DATA, type BabelData } from "../src/storage/persist";
import {
  isFirstRun, mountPhoneUiInto, nowInner, renderConversation, setupInner, voiceInner, wordsInner,
  type ConversationState, type PhoneUiPorts, type UiRoot, type VoiceUiState,
} from "../src/ui/phone";
import type { VocabEntry } from "../src/companion/vocab";

// 1.0.0 phone: three tabs (Jetzt, Meine Wörter, Einstellungen), the voice card, the first-run checklist.

const state = (over: Partial<ConversationState> = {}): ConversationState => ({
  log: [], pending: null, summary: null, insights: [], canSummarize: false, ...over,
});
const entry = (word: string, meaning = "", alternatives: string[] = []): VocabEntry => ({ word, meaning, alternatives, at: 1 });

describe("Jetzt", () => {
  it("shows the three modes as buttons, the pressed one marked, and says what the glasses do", () => {
    const html = nowInner(state({ talkMode: "learn", overview: { data: EMPTY_DATA, listening: false, sttStatus: "idle", memory: "unknown" } }), "de");
    expect(html).toContain("Bereit – wähle auf der Brille einen Modus");
    for (const mode of ["translate", "learn", "client"]) expect(html).toContain(`id="talk-mode-${mode}"`);
    expect(html).toMatch(/id="talk-mode-learn"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/id="talk-mode-translate"[^>]*aria-pressed="false"/);
    for (const label of ["Übersetzen", "Englisch sprechen", "Gespräch"]) expect(html).toContain(">" + label + "<");
    expect(html).toContain("DEMO");
    const live = nowInner(state({ talkMode: "translate", overview: { data: { ...EMPTY_DATA, sttUrl: "wss://s.example" }, listening: true, sttStatus: "ready", memory: "ok" } }), "en");
    expect(live).toContain("The glasses are listening");
    expect(live).not.toContain("MOCK");
  });

  it("offers the customer picker only for Gespräch, with the picked customer selected", () => {
    const customers = [{ id: "c_1", name: "Alpha <b>" }, { id: "c_2", name: "Beta" }];
    const html = nowInner(state({ talkMode: "client", customers, customerId: "c_2" }), "de");
    expect(html).toContain('id="customer-pick"');
    expect(html).toContain('<option value="c_2" selected>Beta</option>');
    expect(html).toContain("Alpha &lt;b&gt;");
    expect(html).toContain(">Ohne Kunde<");
    expect(nowInner(state({ talkMode: "translate", customers }), "de")).not.toContain("customer-pick");
    expect(nowInner(state({ talkMode: "client", customers: [] }), "de")).not.toContain("customer-pick");
  });

  it("the transcript card no longer carries the mode switch", async () => {
    const { conversationInner } = await import("../src/ui/phone");
    expect(conversationInner(state({ talkMode: "client" }), "de")).not.toContain("talk-mode");
  });
});

describe("Meine Wörter", () => {
  it("shows the count and the list in the order given (newest first), each with a delete button, and clear all", () => {
    const html = wordsInner([entry("estimate", "Kostenvoranschlag", ["quote"]), entry("offer", "Angebot")], "de");
    expect(html).toContain("2 Wörter");
    expect(html.indexOf("estimate")).toBeLessThan(html.indexOf("offer"));
    expect(html).toContain("→ Kostenvoranschlag");
    expect(html).toContain('data-word-del="offer"');
    expect(html).toContain('id="words-clear"');
    expect(wordsInner([], "de")).toContain("Noch keine Wörter gefunden.");
    expect(wordsInner([], "de")).not.toContain("words-clear");
  });
});

describe("Meine Stimme", () => {
  it("not trained: a big learn button and how to do it, no delete", () => {
    const html = voiceInner({ trained: false, phase: "idle" }, "de");
    expect(html).toContain("Noch keine Stimme gelernt");
    expect(html).toContain("Brille aufsetzen und den Text auf der Brille vorlesen.");
    expect(html).toMatch(/<button type="button" id="voice-learn" class="big">Stimme lernen<\/button>/);
    expect(html).not.toContain("voice-delete");
  });

  it("trained: relearn and delete; a running step disables both and says what happens", () => {
    const idle = voiceInner({ trained: true, phase: "idle" }, "de");
    expect(idle).toContain("Stimme gelernt");
    expect(idle).toContain("Stimme neu lernen");
    expect(idle).toContain('id="voice-delete"');
    const busy = voiceInner({ trained: true, phase: "reading" }, "de");
    expect(busy).toContain("Lies jetzt den Text auf der Brille vor");
    expect(busy.match(/ disabled>/g)).toHaveLength(2);
    expect(busy).not.toContain("Brille aufsetzen");
  });

  it("shows the result or the problem of the last action, escaped", () => {
    expect(voiceInner({ trained: true, phase: "done", message: "Gespeichert" }, "de")).toContain('<p class="ok">Gespeichert</p>');
    expect(voiceInner({ trained: false, phase: "error", message: "Zu <wenig> Stimme" }, "de")).toContain('<p class="warn">Zu &lt;wenig&gt; Stimme</p>');
  });
});

describe("first run", () => {
  it("nothing configured: the checklist leads Server, Stimme, Fertig", () => {
    expect(isFirstRun(EMPTY_DATA)).toBe(true);
    const html = setupInner(EMPTY_DATA, "de");
    expect(html.match(/<li/g)).toHaveLength(3);
    expect(html).toContain("Server eintragen");
    expect(html).toContain("Stimme lernen");
    expect(html).toContain("Ohne Server läuft die Demo");
    expect(html).not.toContain('class="done"');
  });

  it("ticks off the steps as they are done", () => {
    const server: BabelData = { ...EMPTY_DATA, sttUrl: "wss://s.example/asr" };
    expect(isFirstRun(server)).toBe(false);
    expect(setupInner(server, "de").match(/class="done"/g)).toHaveLength(1);
    const all = setupInner({ ...server, voiceEnrolled: true }, "en");
    expect(all.match(/class="done"/g)).toHaveLength(3);
    expect(all).not.toContain("demo");
    expect(isFirstRun({ ...EMPTY_DATA, voiceEnrolled: true })).toBe(false);
  });
});

/** A root that keeps real listeners per element id and lets a test click an inner control. */
function clickableRoot() {
  type El = { value: string; checked: boolean; hidden: boolean; textContent: string; innerHTML: string; dataset: Record<string, string>;
    listeners: Record<string, Array<(e: { target: unknown }) => void>>; addEventListener(type: string, fn: (e: { target: unknown }) => void): void };
  const elements = new Map<string, El>();
  const el = (id: string): El => {
    let e = elements.get(id);
    if (!e) {
      e = { value: "", checked: false, hidden: false, textContent: "", innerHTML: "", dataset: {}, listeners: {},
        addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); } };
      elements.set(id, e);
    }
    return e;
  };
  let html = "";
  const root: UiRoot & { on(card: string, type: string, target: object): void; el: typeof el } = {
    get innerHTML() { return html; },
    set innerHTML(value: string) { html = value; for (const e of elements.values()) e.listeners = {}; },
    querySelector: ((selector: string) => el(selector.replace(/^#/, ""))) as UiRoot["querySelector"],
    on(card, type, target) { for (const fn of [...(el(card).listeners[type] ?? [])]) fn({ target }); },
    el,
  };
  return root;
}

describe("buttons", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { confirm: () => true, scrollTo: () => undefined });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function mount(over: Partial<PhoneUiPorts> = {}, data: BabelData = EMPTY_DATA) {
    const root = clickableRoot();
    const commits: BabelData[] = [];
    const calls: string[] = [];
    mountPhoneUiInto(root, {
      getData: () => data,
      setData: async (next) => { commits.push(next); },
      getLocale: () => "de",
      getConversation: () => state({ talkMode: "client", customers: [{ id: "c_1", name: "Alpha" }] }),
      onLearnVoice: () => { calls.push("learn"); },
      onDeleteVoice: () => { calls.push("delete"); },
      onPickCustomer: (id) => { calls.push("pick:" + String(id)); },
      ...over,
    });
    return { root, commits, calls };
  }

  it("Stimme lernen starts the recording on the glasses; Stimme löschen asks first", () => {
    const { root, calls } = mount();
    root.on("voice", "click", { id: "voice-learn" });
    expect(calls).toEqual(["learn"]);
    root.on("voice", "click", { id: "voice-delete" });
    expect(calls).toEqual(["learn", "delete"]);
    vi.stubGlobal("window", { confirm: () => false, scrollTo: () => undefined });
    root.on("voice", "click", { id: "voice-delete" });
    expect(calls).toEqual(["learn", "delete"]);
  });

  it("a mode button stores the mode; the customer picker reports the pick", async () => {
    const { root, commits, calls } = mount();
    root.on("now", "click", { dataset: { talkMode: "learn" } });
    await Promise.resolve();
    expect(commits.at(-1)?.talkMode).toBe("learn");
    root.on("now", "change", { id: "customer-pick", value: "c_1" });
    root.on("now", "change", { id: "customer-pick", value: "" });
    expect(calls).toEqual(["pick:c_1", "pick:null"]);
  });

  it("people, the English-translation switch and the automatic word finder commit at once", async () => {
    const { root, commits } = mount();
    root.el("persons").value = "4";
    root.el("persons").listeners["change"]?.forEach((fn) => fn({ target: root.el("persons") }));
    root.el("learn-translate").checked = false;
    root.el("learn-translate").listeners["change"]?.forEach((fn) => fn({ target: root.el("learn-translate") }));
    root.el("word-auto").checked = false;
    root.el("word-auto").listeners["change"]?.forEach((fn) => fn({ target: root.el("word-auto") }));
    await Promise.resolve();
    expect(commits[0]?.persons).toBe(4);
    expect(commits[1]?.learnTranslate).toBe(false);
    expect(commits[2]?.wordAuto).toBe(false);
  });

  it("a word is deleted with its button; all words only after the confirmation", () => {
    const deleted: string[] = [];
    let cleared = 0;
    const { root } = mount({ onDeleteWord: (word) => { deleted.push(word); }, onClearWords: () => { cleared += 1; } });
    root.on("words", "click", { dataset: { wordDel: "offer" } });
    expect(deleted).toEqual(["offer"]);
    root.on("words", "click", { id: "words-clear" });
    expect(cleared).toBe(1);
    vi.stubGlobal("window", { confirm: () => false, scrollTo: () => undefined });
    root.on("words", "click", { id: "words-clear" });
    expect(cleared).toBe(1);
  });

  it("redraws the controls only when they changed, so an open picker is not closed by every new line", () => {
    const { root } = mount();
    const conv = state({ talkMode: "client", customers: [{ id: "c_1", name: "Alpha" }], voice: { trained: false, phase: "idle" } as VoiceUiState });
    renderConversation(root, conv, "de");
    const first = root.el("now-body").innerHTML;
    expect(first).toContain("customer-pick");
    root.el("now-body").innerHTML = "touched by the user";
    renderConversation(root, conv, "de");
    expect(root.el("now-body").innerHTML).toBe("touched by the user"); // identical state: left alone
    renderConversation(root, { ...conv, customerId: "c_1" }, "de");
    expect(root.el("now-body").innerHTML).toContain("selected");
  });
});
