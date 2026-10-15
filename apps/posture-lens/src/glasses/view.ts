import { heldSeconds, uprightShare, type PostureMonitor, type PostureSettings } from "../posture/monitor";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { fitView } from "./fit";
import { armedFooter, armedMenuFooter, footer } from "./footer";

/**
 * What the glasses show.
 *
 * The governing rule: **good posture costs no attention.** When the user is
 * upright the display is nearly empty — a single quiet line. It becomes
 * prominent only when something needs to change. A monitor that is always
 * shouting is a monitor people stop reading.
 */
export interface PostureView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

export interface ViewOptions {
  /** Show the live angle even while upright. Off by default: it draws the eye. */
  readonly showAngleWhenGood?: boolean;
  /** Language for every line; English when omitted. */
  readonly locale?: Locale;
  /** True for a few seconds after a calibration, so the empty display is not mistaken for a fault. */
  readonly justCalibrated?: boolean;
  /** The glasses refused IMU reporting: nothing can be measured until the app is reopened. */
  readonly sensorOff?: boolean;
  /**
   * Something is armed (QIS v1): `calibrate` = overwriting the saved posture (a second tap does it),
   * `reset` = clearing today's tally from the side menu (the same menu entry again does it).
   */
  readonly confirm?: "calibrate" | "reset" | null;
  /** A short note instead of the state in the header ("Tally cleared") for a few seconds. */
  readonly note?: string | null;
  /** The hold opens the app's own menu (no side menu): the footer names it. */
  readonly holdMenu?: boolean;
}

export function buildView(
  monitor: PostureMonitor,
  settings: PostureSettings,
  options: ViewOptions = {},
  now = Date.now(),
): PostureView {
  const view = composeView(monitor, settings, options, now);
  // An armed overwrite always says so in the footer, whatever the state shows.
  const locale = options.locale ?? "en";
  if (options.confirm === "reset" && !options.sensorOff) {
    return fitView({ ...view, header: head(locale, t(locale, "g.sResetAsk")), footer: armedMenuFooter(locale, t(locale, "g.a.clear")) });
  }
  const confirm = options.confirm === "calibrate" && !options.sensorOff
    ? armedFooter(locale, t(locale, "g.a.resave"))
    : null;
  const noted = options.note && !options.sensorOff ? { ...view, header: head(locale, options.note) } : view;
  return fitView(confirm ? { ...noted, footer: confirm } : noted);
}

/** The view before the safety cut; tests check it never needs one. */
export function composeView(
  monitor: PostureMonitor,
  settings: PostureSettings,
  options: ViewOptions = {},
  now = Date.now(),
): PostureView {
  const locale = options.locale ?? "en";
  // Without the sensor nothing else on screen would be true; say what to do instead.
  if (options.sensorOff) {
    return {
      header: head(locale, t(locale, "g.sSensorOff")),
      body: [t(locale, "g.sensorOff1"), t(locale, "g.sensorOff2"), t(locale, "g.sensorOff3")],
      footer: footer(locale, {}, "exit"),
    };
  }

  switch (monitor.state) {
    case "uncalibrated":
      // First run: one sentence saying exactly what to do next.
      return {
        header: head(locale, t(locale, "g.sFirst")),
        body: [t(locale, "g.first1"), t(locale, "g.first2")],
        footer: footer(locale, { tap: t(locale, "g.w.save"), ...(options.holdMenu ? { hold: t(locale, "g.w.menu") } : {}) }, "exit"),
      };

    case "good":
      return {
        header: head(locale, options.justCalibrated ? t(locale, "g.sSaved") : quietState(monitor, locale)),
        body: options.justCalibrated
          ? [t(locale, "g.saved1"), t(locale, "g.saved2")]
          : options.showAngleWhenGood && monitor.angle !== null
            ? [formatAngle(monitor.angle, locale)]
            : [],
        footer: gestureFooter(locale, options.holdMenu),
      };

    case "leaning": {
      const held = heldSeconds(monitor, now) ?? 0;
      const remaining = Math.max(0, settings.sustainSeconds - held);
      return {
        // Counting down is information, not nagging: it says a warning is
        // coming and gives the user the chance to pre-empt it.
        header: head(locale, remaining > 0
          ? t(locale, "g.leaningIn", { time: formatDuration(remaining, locale) })
          : t(locale, "g.leaning")),
        body: [formatAngle(monitor.angle, locale)],
        footer: gestureFooter(locale, options.holdMenu),
      };
    }

    case "warned":
      return {
        header: head(locale, t(locale, "g.warnHeader")),
        body: [
          formatAngle(monitor.angle, locale),
          t(locale, "g.held", { time: formatDuration(heldSeconds(monitor, now) ?? 0, locale) }),
          t(locale, "g.straighten"),
        ],
        footer: gestureFooter(locale, options.holdMenu),
      };

    default:
      return { header: head(locale, t(locale, "g.sFirst")), body: [], footer: gestureFooter(locale, options.holdMenu) };
  }
}

/** `POSTURE · state` - the header of every posture screen (QIS v1). */
function head(locale: Locale, state: string): string {
  return `${t(locale, "g.title")} · ${state}`;
}

/** The quiet state: the share of time upright, nothing else. */
function quietState(monitor: PostureMonitor, locale: Locale): string {
  const share = uprightShare(monitor);
  if (share === null) return t(locale, "g.tracking");
  return t(locale, "g.upright", { pct: Math.round(share * 100) });
}

/** What the gestures do on the posture screen. A swipe does nothing here, so it is not listed. */
function gestureFooter(locale: Locale, holdMenu = false): string {
  return footer(locale, { tap: t(locale, "g.w.resave"), ...(holdMenu ? { hold: t(locale, "g.w.menu") } : {}) }, "exit");
}

export function formatAngle(angle: number | null, locale: Locale = "en"): string {
  if (angle === null) return "--";
  return t(locale, "g.angle", { deg: Math.round(angle) });
}

export function formatDuration(totalSeconds: number, locale: Locale = "en"): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return t(locale, "u.s", { s: seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? t(locale, "u.m", { m: minutes }) : t(locale, "u.ms", { m: minutes, s: rest });
}
