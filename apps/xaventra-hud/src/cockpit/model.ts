import type { Locale } from "../i18n";
import { t } from "../messages";
import { footer } from "../glasses/footer";
import { currentCard, type HudModel } from "../hud/model";
import { hhmm, type CockpitCell, type CockpitGraphic, type CockpitModel, type Tone } from "./compose";

/**
 * What the status cockpit shows, in words and numbers, decided without
 * drawing (QUS v1): the headline, the label/value cells, the graphic for the
 * left half, the caption and the hint line. compose.ts only lays this out.
 */

const DASH = "–";
/** Status lines that mean "nothing going on" rather than "Xaventra is busy". */
const QUIET_STATUS = /^(alles ruhig|ruhig|nichts|bereit|idle|ok\b|all quiet|nothing|ready|)$/i;

/** How Xaventra stands: offline (cannot be reached), critical (the server answers with a fault), warn (questions wait) or ok. */
export function statusTone(model: HudModel): Tone {
  if (!model.online) return model.fault ? "critical" : "offline";
  return (model.feed?.cards.length ?? 0) > 0 ? "warn" : "ok";
}

/** The one statement of the page: "2 FRAGEN", "ARBEITET", "BEREIT", "OFFLINE", "VERBINDE" or "FEHLER". */
export function statusLines(model: HudModel, locale: Locale): string[] {
  if (!model.online) {
    if (model.fault) return [t(locale, "g.cp.fault")];
    return [t(locale, model.problem ? "g.cp.offline" : "g.cp.connecting")];
  }
  const cards = model.feed?.cards.length ?? 0;
  if (cards > 0) return [t(locale, cards === 1 ? "g.cp.cardsOne" : "g.cp.cardsMany", { n: cards })];
  const status = model.feed?.status.trim() ?? "";
  return [t(locale, QUIET_STATUS.test(status) ? "g.cp.idle" : "g.cp.working")];
}

/** The graphic: one arc per open question (a calm full ring when there is none); the centre is their number. */
export function statusGraphic(model: HudModel, locale: Locale): CockpitGraphic {
  const tone = statusTone(model);
  const cards = model.feed?.cards.length ?? 0;
  if (!model.online) return { kind: "ring", segments: [tone], center: DASH, sub: t(locale, "g.cp.ringSub") };
  if (cards === 0) return { kind: "ring", segments: ["ok"], center: "0", sub: t(locale, "g.cp.ringSub") };
  return { kind: "ring", segments: Array.from({ length: cards }, (): Tone => "warn"), center: String(cards), sub: t(locale, "g.cp.ringSub") };
}

/** Fragen, Server, Stand and what the next question does outside. */
export function statusCells(model: HudModel, locale: Locale): CockpitCell[] {
  const cards = model.feed?.cards.length ?? 0;
  const card = currentCard(model);
  const effect = card && card.effect.trim().toLowerCase() !== "intern" ? card.effect : card ? t(locale, "g.cp.internal") : DASH;
  return [
    { label: t(locale, "g.cp.cellCards"), value: model.online ? String(cards) : DASH, ...(cards > 0 ? { alert: true } : {}) },
    { label: t(locale, "g.cp.cellServer"), value: model.demo ? t(locale, "g.state.demo") : t(locale, model.online ? "g.cp.serverOk" : "g.cp.serverDown"), ...(!model.online && !model.demo ? { alert: true } : {}) },
    { label: t(locale, "g.cp.cellStand"), value: model.feedAt > 0 ? hhmm(model.feedAt) : DASH },
    { label: t(locale, "g.cp.cellEffect"), value: effect },
  ];
}

/** Left bottom: a feedback line, else what Xaventra is doing, else the problem. */
export function captionFor(model: HudModel): string {
  if (model.message) return model.message;
  if (model.feed?.status && model.online) return model.feed.status;
  return model.problem;
}

/** The hint line: only the gestures that do something here. */
export function cockpitHint(locale: Locale): string {
  return footer(locale, { tap: t(locale, "g.f.reload"), hold: t(locale, "g.f.speak") }, "back");
}

export function cockpitModel(model: HudModel, locale: Locale, now: Date): CockpitModel {
  return {
    title: t(locale, "g.title").toUpperCase(),
    clock: hhmm(now.getTime()),
    headline: statusLines(model, locale),
    cells: statusCells(model, locale),
    graphic: statusGraphic(model, locale),
    caption: captionFor(model),
    hint: cockpitHint(locale),
    tone: statusTone(model),
  };
}
