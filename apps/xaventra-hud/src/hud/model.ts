import type { Answer, HudCard, HudFeed } from "../api/types";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { armedFooter, footer } from "../glasses/footer";
import { MAX_BODY_ROWS, fit, wrap, type ScreenView } from "../glasses/screen";

/**
 * The HUD's logic without any SDK: what the glasses show for a given state,
 * and what a gesture means. Kept pure so it can be tested exhaustively.
 *
 * Safety rules that live here (QIS v1 + v1.2, docs/BEDIENSTANDARD.md):
 *  - An answer is never mapped to a swipe. The choice is a list (Ja / Nein / Hilfe without the side menu);
 *    a swipe only moves the cursor, a tap arms the chosen entry and a second
 *    single tap within CONFIRM_MS sends it. A swipe, a double tap or the
 *    timeout cancels.
 *  - Speech never answers on the wearer's behalf (v1.2 #4): a spoken yes/no
 *    only selects and arms that entry; the confirming tap sends it.
 *  - Recognised free text is shown first (`draft`); a tap sends it, 2×
 *    discards it. Nothing goes out on the release alone when the text is known.
 *  - While a voice reply is on screen, a tap only closes it - it never answers
 *    the card behind it.
 *  - There is no help page (QUS v1): the gestures are in the footer line, the setup is on the phone.
 *  - "Always allow" does not exist on the glasses.
 *  - The choice belongs to one card id and never carries over to another card.
 */

/**
 * The glasses' side menu. Off: its clicks never reach the app on the real glasses and a hold
 * opens the menu instead of reaching the app (step log of 15.10.2026), so a hold speaks.
 */
export const SIDE_MENU = false;

/** What is on the glasses: the start page, the status cockpit or the open questions. */
export type Screen = "start" | "status" | "cards";

export type RecPhase = "off" | "opening" | "listening" | "sending";

export interface VoiceReply {
  readonly transcript: string;
  readonly reply: string;
}

export interface HudModel {
  readonly configured: boolean;
  /** The first-start sample data (no server entered): the glasses say so in the start page. */
  readonly demo: boolean;
  readonly screen: Screen;
  /** The cursor of the start page. */
  readonly startCursor: number;
  /** When the feed was last answered (ms since epoch), 0 = never. */
  readonly feedAt: number;
  readonly online: boolean;
  /** Short, already localised problem text shown instead of the feed. */
  readonly problem: string;
  /** The server answered with a problem (auth, HTTP error, bad reply), as opposed to not answering at all. */
  readonly fault: boolean;
  readonly feed: HudFeed | null;
  readonly index: number;
  /** Card id waiting for the confirming second tap. */
  readonly confirm: string | null;
  /** Card id on which "Nein" is selected (swiped to); null = "Ja" is selected. */
  readonly nein: string | null;
  /** One transient line, already localised (shown in the body, never as the footer). */
  readonly message: string;
  readonly voice: VoiceReply | null;
  readonly rec: RecPhase;
  /** What the live recogniser heard so far in this recording ("" without live STT). */
  readonly live: string;
  /** When the microphone opened (ms since epoch), 0 when off. */
  readonly recSince: number;
  /** Recognised text waiting for the wearer: a tap sends it, 2× discards it ("" = none). */
  readonly draft: string;
}

export const EMPTY_MODEL: HudModel = {
  configured: false, demo: false, screen: "start", startCursor: 0, feedAt: 0, online: false, problem: "", fault: false, feed: null, index: 0,
  confirm: null, nein: null, message: "", voice: null, rec: "off", live: "", recSince: 0, draft: "",
};

/** The second tap must come within this time. */
export const CONFIRM_MS = 4_000;

export type HudGesture = "click" | "doubleClick" | "scrollUp" | "scrollDown";

export type HudAction =
  | { readonly kind: "answer"; readonly cardId: string; readonly answer: Answer }
  | { readonly kind: "confirm"; readonly cardId: string }
  | { readonly kind: "move"; readonly index: number; readonly nein: string | null }
  | { readonly kind: "disarm" }
  | { readonly kind: "open"; readonly screen: Screen }
  | { readonly kind: "startMove"; readonly cursor: number }
  | { readonly kind: "refresh" }
  | { readonly kind: "back" }
  | { readonly kind: "dismiss" }
  | { readonly kind: "sendDraft" }
  | { readonly kind: "discardDraft" }
  | { readonly kind: "exit" }
  | { readonly kind: "none" };

export function currentCard(model: HudModel): HudCard | null {
  const cards = model.feed?.cards ?? [];
  return cards.length ? cards[Math.min(model.index, cards.length - 1)] ?? null : null;
}

/** Whether "Nein" is the selected answer on the card shown now. */
export function neinSelected(model: HudModel): boolean {
  const card = currentCard(model);
  return card !== null && model.nein === card.id;
}

const YES = new Set(["ja", "jawohl", "ja bitte", "ok", "okay", "passt", "yes", "yeah", "yep", "yes please"]);
const NO = new Set(["nein", "nee", "nö", "nein danke", "stopp", "stop", "no", "nope", "no thanks"]);

/** A recognised sentence that is nothing but a yes or a no; anything longer is free text. */
export function spokenAnswer(text: string): Answer | null {
  const plain = text.toLowerCase().replace(/[.,!?;:"'…]+/g, " ").replace(/\s+/g, " ").trim();
  if (YES.has(plain)) return "ja";
  if (NO.has(plain)) return "nein";
  return null;
}

/** The rows of the start page: the open questions first (the thing to act on), then the status cockpit. */
export type StartRow = { readonly kind: "cards"; readonly count: number } | { readonly kind: "status" };

export function startRows(model: HudModel): StartRow[] {
  return [{ kind: "cards", count: model.feed?.cards.length ?? 0 }, { kind: "status" }];
}

/**
 * Start page: tap opens the entry, swipe moves, 2x leaves. Status cockpit: tap asks again, 2x goes back.
 * Questions: tap = arm the chosen entry, second tap = send, swipe = move the cursor through Ja/Nein of each
 * card, double tap = cancel an armed answer, else back. Never sends on a swipe. With recognised text
 * waiting: tap = send it, double tap = discard it.
 */
export function decide(model: HudModel, gesture: HudGesture): HudAction {
  if (model.voice) return { kind: "dismiss" };
  if (model.draft) {
    if (gesture === "click") return { kind: "sendDraft" };
    if (gesture === "doubleClick") return { kind: "discardDraft" };
    return { kind: "none" };
  }
  if (model.screen === "start") {
    const rows = startRows(model);
    if (gesture === "doubleClick") return { kind: "exit" };
    if (gesture === "click") return { kind: "open", screen: rows[model.startCursor]?.kind === "status" ? "status" : "cards" };
    return { kind: "startMove", cursor: Math.min(rows.length - 1, Math.max(0, model.startCursor + (gesture === "scrollDown" ? 1 : -1))) };
  }
  if (model.screen === "status") {
    if (gesture === "click") return { kind: "refresh" };
    if (gesture === "doubleClick") return { kind: "back" };
    return { kind: "none" };
  }
  if (gesture === "doubleClick") return model.confirm !== null ? { kind: "disarm" } : { kind: "back" };
  const card = currentCard(model);
  const cards = model.feed?.cards ?? [];
  if (gesture === "scrollUp" || gesture === "scrollDown") {
    if (!card) return { kind: "none" };
    // Two stops per card (Ja, Nein).
    const stops = cards.length * 2;
    const at = Math.min(model.index, cards.length - 1) * 2 + (neinSelected(model) ? 1 : 0);
    const next = (at + (gesture === "scrollDown" ? 1 : -1) + stops) % stops;
    const index = Math.floor(next / 2);
    return { kind: "move", index, nein: next % 2 === 1 ? cards[index]?.id ?? null : null };
  }
  if (!card) return { kind: "none" };
  if (model.confirm !== card.id) return { kind: "confirm", cardId: card.id };
  return { kind: "answer", cardId: card.id, answer: neinSelected(model) ? "nein" : "ja" };
}

function effectLabel(effect: string, locale: Locale): string {
  const lower = effect.trim().toLowerCase();
  if (lower === "intern") return "";
  if (lower.includes("phys")) return t(locale, "g.eff.physical");
  if (lower.includes("auß") || lower.includes("auss") || lower.includes("outward") || lower.includes("extern")) return t(locale, "g.eff.outward");
  return effect;
}

/** First `rows` rows; when something is left out the last kept row ends in an ellipsis. */
function cut(rows: readonly string[], keep: number): string[] {
  if (rows.length <= keep) return [...rows];
  const kept = rows.slice(0, Math.max(0, keep));
  if (kept.length > 0) kept[kept.length - 1] = fit(kept[kept.length - 1] + "…");
  return kept;
}

/** The newest `keep` rows of a long text; a cut is marked with a leading ellipsis. */
export function lastRows(rows: readonly string[], keep: number): string[] {
  if (rows.length <= keep) return [...rows];
  const kept = rows.slice(rows.length - Math.max(0, keep));
  if (kept.length > 0) kept[0] = fit("…" + kept[0]);
  return kept;
}

/** m:ss of a running recording. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const MARK_ON = "● ";
const MARK_OFF = "○ ";
const START_ON = "● ";

/** The state in the header: `● live`, `Demo`, `offline` or `verbinde`. */
export function liveLabel(model: HudModel, locale: Locale): string {
  if (model.demo) return t(locale, "g.state.demo");
  if (model.online) return "● " + t(locale, "g.live");
  return t(locale, model.problem ? "g.state.offline" : "g.state.connecting");
}

export function buildView(model: HudModel, locale: Locale, now: Date): ScreenView {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const state = (what: string, title: string = x("g.title")): string => fit(`${title} · ${what}`);
  const messageRows = (rows: number): string[] => (model.message ? ["", ...wrap(model.message).slice(0, rows)] : []);

  if (model.rec !== "off") {
    const time = model.recSince && model.rec === "listening" ? ` ${elapsed(now.getTime() - model.recSince)}` : "";
    const header = state(`${x("g.state.mic")}${time}`);
    const live = model.live.trim();
    // 2× cancels a recording in every phase.
    const cancelOnly = footer(locale, {}, "cancel");
    if (model.rec === "sending") {
      // What was said stays visible; the status line shows Xaventra's progress meanwhile.
      const progress = model.feed?.status ? wrap(`> ${model.feed.status}`).slice(0, 1) : [];
      if (!live) return { header, body: ["", x("g.rec.sending"), ...(progress.length ? ["", ...progress] : [])], footer: cancelOnly };
      const said = lastRows(wrap(`${x("g.you")} ${live}`), MAX_BODY_ROWS - 4 - progress.length);
      return { header, body: [...said, "", x("g.rec.sending"), ...(progress.length ? ["", ...progress] : [])], footer: cancelOnly };
    }
    if (model.rec === "opening") return { header, body: ["", x("g.rec.opening")], footer: cancelOnly };
    const hint = footer(locale, { release: x("g.f.done") }, "cancel");
    if (live) return { header, body: lastRows(wrap(live), MAX_BODY_ROWS), footer: hint };
    return { header, body: ["", x("g.rec.listen")], footer: hint };
  }

  if (model.voice) {
    const you = wrap(`${x("g.you")} ${model.voice.transcript}`).slice(0, 2);
    const reply = model.voice.reply ? wrap(`${x("g.reply")} ${model.voice.reply}`).slice(0, MAX_BODY_ROWS - you.length - 1) : [];
    return { header: state(x("g.state.voice")), body: [...you, "", ...reply], footer: footer(locale, { tap: x("g.f.close") }, "back") };
  }

  if (model.draft) {
    // v1.2: what was recognised is shown first; only the tap sends it.
    return {
      header: state(x("g.state.draft")),
      body: lastRows(wrap(`${x("g.you")} ${model.draft}`), MAX_BODY_ROWS),
      footer: footer(locale, { tap: x("g.f.send") }, "discard"),
    };
  }

  if (!model.configured) {
    return { header: state(x("g.state.setup")), body: ["", x("g.setup1"), x("g.setup2")], footer: footer(locale, {}, "exit") };
  }

  if (model.screen !== "cards") {
    // The start page: at most three entries (QUS 1.1), the cursor is a dot; the status cockpit is an image (src/cockpit).
    const rows = startRows(model);
    const at = Math.min(Math.max(0, model.startCursor), rows.length - 1);
    const body = rows.map((row, index) => fit((index === at ? START_ON : "  ") + (row.kind === "cards" ? `${x("g.start.cards")} · ${row.count}` : x("g.start.status"))));
    if (model.problem && !model.online) body.push(...wrap(model.problem).slice(0, 1));
    else if (model.message) body.push(...wrap(model.message).slice(0, 1));
    if (model.demo) body.push(x("g.demoHint"));
    return { header: state(liveLabel(model, locale)), body, footer: footer(locale, { tap: x("g.f.open"), swipe: true, hold: x("g.f.speak") }, "exit") };
  }

  if (!model.feed) {
    return {
      header: state(x(model.problem ? "g.state.offline" : "g.state.connecting")),
      body: ["", ...wrap(model.problem || x("g.state.connecting")).slice(0, 3)],
      footer: footer(locale, {}, "back"),
    };
  }

  const status = wrap(`> ${model.feed.status}`).slice(0, 1);
  const card = currentCard(model);
  if (!card) {
    const lines = [...status, "", x("g.nocards")];
    if (model.problem) lines.push("", ...wrap(model.problem).slice(0, 2));
    else lines.push(...messageRows(2));
    return {
      header: state(liveLabel(model, locale), x("g.start.cards")),
      body: lines.slice(0, MAX_BODY_ROWS),
      footer: footer(locale, { hold: x("g.f.speak") }, "back"),
    };
  }

  const total = model.feed.cards.length;
  const effect = effectLabel(card.effect, locale);
  const armed = model.confirm === card.id;
  const position = x("g.state.card", { n: Math.min(model.index, total - 1) + 1, total });
  const header = state(armed ? x("g.state.armed") : liveLabel(model, locale), position);
  const nein = neinSelected(model);
  // List rows at the bottom: the answers; the cursor is the filled dot.
  const options = [
    fit((!nein ? MARK_ON : MARK_OFF) + x("g.opt.yes")),
    fit((nein ? MARK_ON : MARK_OFF) + x("g.opt.no")),
  ];
  const note = model.message ? wrap(model.message).slice(0, 1) : [];
  const room = MAX_BODY_ROWS - status.length - options.length - note.length;
  // What the card does outside shows in front of its title (an internal card says nothing).
  const titleRows = cut(wrap(effect ? `${effect}: ${card.title}` : card.title), Math.min(2, Math.max(1, room - 1)));
  const textRows = cut(wrap(card.text), Math.max(0, room - titleRows.length));
  const body = [...status, ...titleRows, ...textRows].slice(0, MAX_BODY_ROWS - options.length - note.length).concat(note, options);
  const foot = armed
    ? armedFooter(locale, x(nein ? "g.f.sendNo" : "g.f.sendYes"))
    : footer(locale, { tap: x("g.f.choose"), swipe: true, hold: x("g.f.speak") }, "back");
  return { header, body, footer: foot };
}
