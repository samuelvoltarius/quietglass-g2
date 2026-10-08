/**
 * What the Xaventra Even G2 endpoint (docs/EVEN_G2.md in the Xaventra repo)
 * sends back, validated before it reaches the screen. The field names are the
 * daemon's own (German); the app's names are English.
 *
 * Nothing here trusts the server: every text is clipped, unknown shapes are
 * dropped, and a card without an id is never shown.
 */

export type Answer = "ja" | "nein";

export interface HudCard {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  /** "intern", "physisch", "nach außen", … — anything but "intern" needs a second tap. */
  readonly effect: string;
}

export interface HudFeed {
  readonly version: string;
  readonly status: string;
  readonly cards: readonly HudCard[];
}

export type VoiceAction = "answered_ja" | "answered_nein" | "needs_confirm" | "message" | "none";

export interface VoiceResult {
  readonly transcript: string;
  readonly action: VoiceAction;
  readonly cardId: string;
  readonly reply: string;
}

export interface AnswerResult {
  readonly message: string;
}

const MAX_CARDS = 5;
const ACTIONS: readonly VoiceAction[] = ["answered_ja", "answered_nein", "needs_confirm", "message", "none"];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export function parseFeed(raw: unknown): HudFeed | null {
  const body = record(raw);
  if (!body || typeof body["version"] !== "string") return null;
  const cards: HudCard[] = [];
  if (Array.isArray(body["cards"])) {
    // Cap after filtering, so malformed entries cannot crowd out real cards.
    for (const entry of body["cards"].slice(0, MAX_CARDS * 10)) {
      if (cards.length >= MAX_CARDS) break;
      const card = record(entry);
      const id = text(card?.["id"], 80);
      if (!card || !id) continue;
      cards.push({
        id,
        title: text(card["titel"], 200),
        text: text(card["text"], 400),
        effect: text(card["wirkung"], 40) || "intern",
      });
    }
  }
  return { version: body["version"].slice(0, 80), status: text(body["status"], 300), cards };
}

export function parseVoice(raw: unknown): VoiceResult | null {
  const body = record(raw);
  if (!body) return null;
  const action = ACTIONS.find((candidate) => candidate === body["action"]);
  if (!action) return null;
  return {
    transcript: text(body["transcript"], 500),
    action,
    cardId: text(body["cardId"], 80),
    reply: text(body["reply"], 500),
  };
}

export function parseAnswer(raw: unknown): AnswerResult {
  const body = record(raw);
  return { message: text(body?.["message"], 200) };
}
