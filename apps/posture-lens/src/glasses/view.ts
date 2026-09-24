import { heldSeconds, uprightShare, type PostureMonitor, type PostureSettings } from "../posture/monitor";

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
}

export function buildView(
  monitor: PostureMonitor,
  settings: PostureSettings,
  options: ViewOptions = {},
  now = Date.now(),
): PostureView {
  switch (monitor.state) {
    case "uncalibrated":
      return {
        header: "PostureLens",
        body: [
          "Sit the way you want to sit.",
          "Then tap to set that as upright.",
        ],
        footer: "tap = calibrate",
      };

    case "good":
      return {
        header: "",
        body: options.showAngleWhenGood && monitor.angle !== null
          ? [formatAngle(monitor.angle)]
          : [],
        footer: quietFooter(monitor),
      };

    case "leaning": {
      const held = heldSeconds(monitor, now) ?? 0;
      const remaining = Math.max(0, settings.sustainSeconds - held);
      return {
        header: "",
        body: [formatAngle(monitor.angle)],
        // Counting down is information, not nagging: it says a warning is
        // coming and gives the user the chance to pre-empt it.
        footer: remaining > 0
          ? "leaning · " + formatDuration(remaining) + " to warning"
          : "leaning",
      };
    }

    case "warned":
      return {
        header: "HEAD FORWARD",
        body: [
          formatAngle(monitor.angle),
          "held " + formatDuration(heldSeconds(monitor, now) ?? 0),
        ],
        footer: "straighten up · tap = recalibrate",
      };

    default:
      return { header: "PostureLens", body: [], footer: "" };
  }
}

/** One quiet line: the share of time upright, nothing else. */
function quietFooter(monitor: PostureMonitor): string {
  const share = uprightShare(monitor);
  if (share === null) return "tracking";
  return Math.round(share * 100) + "% upright";
}

export function formatAngle(angle: number | null): string {
  if (angle === null) return "--";
  return Math.round(angle) + "° forward";
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? minutes + "m" : minutes + "m " + rest + "s";
}
