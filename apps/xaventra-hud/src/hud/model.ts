import type { HudCard, HudFeed } from "../api/types";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { MAX_BODY_ROWS, fit, wrap, type ScreenView } from "../glasses/screen";

/**
 * The HUD's logic without any SDK: what the glasses show for a given state,
 * and what a gesture means. Kept pure so it can be tested exhaustively.
 *
 * Safety rules that live here:
 *  - A card whose effect is not "intern" needs a second tap within
 *    CONFIRM_MS before "yes" is sent. Speech never replaces that tap.
 *  - While a voice reply is on screen, a tap only closes it — it never answers
 *    the card behind it.
 *  - "Always allow" does not exist on the glasses.
 */

export type RecPhase = "off" | "opening" | "listening" | "sending";

export interface VoiceReply {
  readonly transcript: string;
  readonly reply: string;
}

export interface HudModel {
  readonly configured: boolean;
  readonly online: boolean;
  /** Short, already localised problem text shown instead of the feed. */
  readonly problem: string;
  readonly feed: HudFeed | null;
  readonly index: number;
  /** Card id waiting for the confirming second tap. */
  readonly confirm: string | null;
  /** One transient line for the footer, already localised. */
  readonly message: string;
  readonly voice: VoiceReply | null;
  readonly rec: RecPhase;
}

export const EMPTY_MODEL: HudModel = {
  configured: false, online: false, problem: "", feed: null, index: 0,
  confirm: null, message: "", voice: null, rec: "off",
};

/** The second tap must come within this time. */
export const CONFIRM_MS = 4_000;

export type HudGesture = "click" | "doubleClick" | "scrollUp" | "scrollDown";

export type HudAction =
  | { readonly kind: "answer"; readonly cardId: string; readonly answer: "ja" | "nein" }
  | { readonly kind: "confirm"; readonly cardId: string }
  | { readonly kind: "move"; readonly index: number }
  | { readonly kind: "dismiss" }
  | { readonly kind: "exit" }
  | { readonly kind: "none" };

export function currentCard(model: HudModel): HudCard | null {
  const cards = model.feed?.cards ?? [];
  return cards.length ? cards[Math.min(model.index, cards.length - 1)] ?? null : null;
}

export function needsConfirm(card: HudCard): boolean {
  return card.effect.trim().toLowerCase() !== "intern";
}

/** Tap = yes, double tap = no (no card: leave), swipe = next card. */
export function decide(model: HudModel, gesture: HudGesture): HudAction {
  if (model.voice) return { kind: "dismiss" };
  const card = currentCard(model);
  const total = model.feed?.cards.length ?? 0;
  if (gesture === "scrollUp" || gesture === "scrollDown") {
    if (total < 2) return { kind: "none" };
    const step = gesture === "scrollDown" ? 1 : -1;
    return { kind: "move", index: (model.index + step + total) % total };
  }
  if (gesture === "doubleClick") return card ? { kind: "answer", cardId: card.id, answer: "nein" } : { kind: "exit" };
  if (!card) return { kind: "none" };
  if (needsConfirm(card) && model.confirm !== card.id) return { kind: "confirm", cardId: card.id };
  return { kind: "answer", cardId: card.id, answer: "ja" };
}

function effectLabel(effect: string, locale: Locale): string {
  const lower = effect.trim().toLowerCase();
  if (lower === "intern") return "";
  if (lower.includes("phys")) return t(locale, "g.eff.physical");
  if (lower.includes("auß") || lower.includes("auss") || lower.includes("outward") || lower.includes("extern")) return t(locale, "g.eff.outward");
  return effect;
}

const clock = (now: Date): string => `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

export function buildView(model: HudModel, locale: Locale, now: Date): ScreenView {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const title = x("g.title");

  if (model.rec !== "off") {
    const body = model.rec === "sending"
      ? ["", x("g.rec.sending")]
      : model.rec === "opening"
        ? ["", x("g.rec.opening")]
        : ["", x("g.rec.listen"), "", x("g.rec.release"), x("g.rec.cancel")];
    return { header: fit(`${title}  ${x("g.mic")}`), body, footer: "" };
  }

  if (model.voice) {
    const you = wrap(`${x("g.you")} ${model.voice.transcript}`).slice(0, 2);
    const reply = model.voice.reply ? wrap(`${x("g.reply")} ${model.voice.reply}`).slice(0, MAX_BODY_ROWS - you.length - 1) : [];
    return { header: fit(`${title} · ${clock(now)}`), body: [...you, "", ...reply], footer: x("g.hint.close") };
  }

  const head = fit(`${title} ${model.online ? "·" : x("g.offline")} ${clock(now)}`);

  if (!model.configured) {
    return { header: head, body: ["", x("g.setup1"), x("g.setup2")], footer: "" };
  }
  if (!model.feed) {
    return { header: head, body: ["", ...wrap(model.problem || x("g.connecting")).slice(0, 3)], footer: "" };
  }

  const status = wrap(`> ${model.feed.status}`).slice(0, 2);
  const card = currentCard(model);
  if (!card) {
    const lines = [...status, "", x("g.nocards")];
    if (model.problem) lines.push("", ...wrap(model.problem).slice(0, 2));
    else if (model.message) lines.push("", ...wrap(model.message).slice(0, 2));
    return { header: head, body: lines.slice(0, MAX_BODY_ROWS), footer: x("g.hint.idle") };
  }

  const total = model.feed.cards.length;
  const effect = effectLabel(card.effect, locale);
  const label = x("g.card", { n: Math.min(model.index, total - 1) + 1, total }) + (effect ? ` (${effect})` : "");
  const room = MAX_BODY_ROWS - status.length - 2;
  const titleRows = wrap(card.title).slice(0, Math.min(2, room - 1));
  const textRows = wrap(card.text).slice(0, Math.max(0, room - titleRows.length));
  const body = [...status, "", fit(label), ...titleRows, ...textRows].slice(0, MAX_BODY_ROWS);
  const footer = model.confirm === card.id
    ? x("g.confirm")
    : model.message ? fit(model.message) : total > 1 ? x("g.hint.cards") : x("g.hint.card");
  return { header: head, body, footer };
}
