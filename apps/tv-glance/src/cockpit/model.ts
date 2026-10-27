import { t } from "../messages";
import { footer } from "../glasses/footer";
import { hasChoice, liveWord, shownVolume, type ViewState } from "../glasses/views";
import { hhmm, type CockpitCell, type CockpitGraphic, type CockpitModel, type Tone } from "./compose";

/**
 * What the remote cockpit shows, decided without drawing (QUS v1). Left: the
 * TV (play / pause / ready / off) and the volume bar; right: what runs, big,
 * then state, sound and source as cells; one hint line. compose.ts lays it out.
 */

const DASH = "–";

const upper = (text: string): string => text.toLocaleUpperCase("de-DE");

/** The state word of a TV that is on. */
export function activityWord(state: ViewState): string {
  const { locale, tv } = state;
  if (!tv) return DASH;
  if (tv.unavailable) return t(locale, "g.cp.offline");
  if (tv.power === "off") return t(locale, "g.cp.off");
  switch (tv.activity) {
    case "playing": return t(locale, "g.cp.playing");
    case "paused": return t(locale, "g.cp.paused");
    case "idle": return t(locale, "g.cp.idle");
    default: return tv.power === "on" ? t(locale, "g.cp.on") : DASH;
  }
}

/** Big line: the app (or source, or the TV's name); second line: the title or the state word. Off: AUS + name. */
export function headline(state: ViewState): string[] {
  const { locale, tv } = state;
  if (!tv) return [DASH, t(locale, state.connection.kind === "error" ? "g.cp.noServer" : "g.cp.loading")];
  if (tv.unavailable) return [t(locale, "g.cp.unavailable"), upper(state.device?.name || tv.name || t(locale, "g.app"))];
  if (tv.power === "off") return [t(locale, "g.cp.off"), upper(tv.name || t(locale, "g.app"))];
  const first = tv.app ?? tv.source ?? tv.name ?? DASH;
  return [upper(first), upper(tv.title ?? activityWord(state))];
}

export function volumeText(state: ViewState): string {
  if (state.tv?.muted) return t(state.locale, "g.cp.muted");
  const volume = shownVolume(state);
  return volume === null ? DASH : String(volume);
}

export function cells(state: ViewState): CockpitCell[] {
  const { locale, tv } = state;
  return [
    { label: t(locale, "g.cp.state"), value: activityWord(state), ...(state.connection.kind === "error" ? { alert: true } : {}) },
    { label: t(locale, "g.cp.sound"), value: volumeText(state), ...(tv?.muted ? { alert: true } : {}) },
    { label: t(locale, "g.cp.source"), value: tv?.source ?? tv?.app ?? DASH },
  ];
}

export function tvGraphic(state: ViewState): CockpitGraphic {
  const { tv } = state;
  const screen = !tv || tv.power === "unknown" ? "unknown" : tv.power === "off" ? "off" : tv.activity === "playing" ? "playing" : tv.activity === "paused" ? "paused" : "idle";
  return {
    kind: "tv",
    screen,
    volume: tv?.power === "on" ? shownVolume(state) : null,
    muted: tv?.muted === true,
    volumeLabel: t(state.locale, "g.cp.volume"),
    volumeText: tv?.power === "on" ? volumeText(state) : DASH,
  };
}

export function tone(state: ViewState): Tone {
  if (!state.tv) return "offline";
  return state.connection.kind === "error" || state.tv.unavailable ? "warn" : "ok";
}

/** The hint line: tap plays/pauses (switches on while off), swipe changes the volume, 2× goes back. A command's result stands in front. */
export function hint(state: ViewState): string {
  const { locale } = state;
  const off = state.tv?.power === "off";
  // An unavailable device takes no commands: only the way back is offered.
  if (state.tv?.unavailable) return state.flash ? `${state.flash} · ${footer(locale, {}, "back")}` : footer(locale, {}, "back");
  const line = footer(locale, { tap: t(locale, off ? "g.f.powerOn" : "g.f.playPause"), swipe: t(locale, "g.f.volume") }, "back");
  return state.flash ? `${state.flash} · ${line}` : line;
}

export function caption(state: ViewState): string {
  if (state.demo) return t(state.locale, "g.demoWord");
  return state.device?.name || (state.tv?.name ?? "");
}

export function cockpitModel(state: ViewState): CockpitModel {
  const word = liveWord(state);
  return {
    title: word === "demo" ? `${t(state.locale, "g.app")} · ${t(state.locale, "g.demoWord")}`
      : hasChoice(state) ? `${t(state.locale, "g.app")} · ${(state.device?.index ?? 0) + 1}/${state.device?.count ?? 1}` : t(state.locale, "g.app"),
    clock: hhmm(state.now),
    headline: headline(state),
    cells: cells(state),
    graphic: tvGraphic(state),
    caption: caption(state),
    hint: hint(state),
    tone: tone(state),
  };
}
