import { heldSeconds, uprightShare, type PostureMonitor, type PostureSettings } from "../posture/monitor";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { fitView } from "./fit";

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
}

export function buildView(
  monitor: PostureMonitor,
  settings: PostureSettings,
  options: ViewOptions = {},
  now = Date.now(),
): PostureView {
  return fitView(composeView(monitor, settings, options, now));
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
      header: t(locale, "g.title"),
      body: [t(locale, "g.sensorOff1"), t(locale, "g.sensorOff2"), t(locale, "g.sensorOff3")],
      footer: t(locale, "g.sensorOffFooter"),
    };
  }

  switch (monitor.state) {
    case "uncalibrated":
      // First run: one sentence saying exactly what to do next.
      return {
        header: t(locale, "g.title"),
        body: [t(locale, "g.first1"), t(locale, "g.first2")],
        footer: t(locale, "g.firstFooter"),
      };

    case "good":
      return {
        header: "",
        body: options.justCalibrated
          ? [t(locale, "g.saved1"), t(locale, "g.saved2")]
          : options.showAngleWhenGood && monitor.angle !== null
            ? [formatAngle(monitor.angle, locale)]
            : [],
        footer: quietFooter(monitor, locale),
      };

    case "leaning": {
      const held = heldSeconds(monitor, now) ?? 0;
      const remaining = Math.max(0, settings.sustainSeconds - held);
      return {
        header: "",
        body: [formatAngle(monitor.angle, locale)],
        // Counting down is information, not nagging: it says a warning is
        // coming and gives the user the chance to pre-empt it.
        footer: remaining > 0
          ? t(locale, "g.leaningIn", { time: formatDuration(remaining, locale) })
          : t(locale, "g.leaning"),
      };
    }

    case "warned":
      return {
        header: t(locale, "g.warnHeader"),
        body: [
          formatAngle(monitor.angle, locale),
          t(locale, "g.held", { time: formatDuration(heldSeconds(monitor, now) ?? 0, locale) }),
        ],
        footer: t(locale, "g.warnFooter"),
      };

    default:
      return { header: t(locale, "g.title"), body: [], footer: "" };
  }
}

/** One quiet line: the share of time upright, nothing else. */
function quietFooter(monitor: PostureMonitor, locale: Locale): string {
  const share = uprightShare(monitor);
  if (share === null) return t(locale, "g.tracking");
  return t(locale, "g.upright", { pct: Math.round(share * 100) });
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
