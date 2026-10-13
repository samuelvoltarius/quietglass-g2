import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { Locale } from "../i18n";
import { t } from "../messages";

/**
 * Which backend to ask, and where it lives. Nothing else is kept.
 *
 * No journey history. Where somebody travels is about as personal as data
 * gets, and the only way to be sure it is not leaked is not to hold it. The
 * favourite destinations the passenger adds by hand live apart, in
 * src/route/places.ts, and are never sent anywhere except as the coordinates
 * of a connection search.
 */

export type BackendId = "oebb" | "motis";

export interface Settings {
  readonly backend: BackendId;
  /** Where the ÖBB proxy runs; see examples/. */
  readonly oebbUrl: string;
  /** Transitous, or your own MOTIS. */
  readonly motisUrl: string;
  /**
   * A Whisper server (OpenAI-compatible) for speaking a destination. Empty
   * means the build's default (VITE_STT_URL in a private build), and without
   * one the voice input says it needs a server of your own.
   */
  readonly sttUrl: string;
  /** Seconds between refreshes while a board is on screen. */
  readonly refreshSeconds: number;
}

const KEY = "quietglass.nextstop.v1";

/**
 * Transitous is the default because it is the only one of the two that a
 * WebView can reach without help: it sends `Access-Control-Allow-Origin: *`,
 * needs no key, and covers many countries. ÖBB carries live delays in
 * Austria but sends no CORS headers, so it only works once the user runs the
 * small proxy from examples/ — an optional upgrade, never the first screen.
 */
/** Set at build time in a private build: `VITE_OEBB_URL=https://… npm run build`. */
const BUILD_OEBB_URL: string | undefined = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_OEBB_URL;

/**
 * The defaults of a build. With a build-time ÖBB proxy (a private build for
 * somebody in Austria) ÖBB live data is on by default and the proxy is its
 * address; a public build has none and starts on Transitous as above.
 */
export function defaultsFor(buildOebbUrl: string | undefined): Settings {
  const built = (buildOebbUrl ?? "").trim();
  const usable = built !== "" && validateUrl(built).valid;
  return {
    backend: usable ? "oebb" : "motis",
    oebbUrl: usable ? built : "http://127.0.0.1:8079/oebb",
    motisUrl: "https://api.transitous.org",
    sttUrl: "",
    refreshSeconds: 30,
  };
}

export const DEFAULT_SETTINGS: Settings = defaultsFor(BUILD_OEBB_URL);

export async function save(bridge: EvenAppBridge, settings: Settings): Promise<void> {
  await bridge.setLocalStorage(KEY, JSON.stringify(settings));
}

export async function load(bridge: EvenAppBridge): Promise<Settings> {
  return parseSettings(await bridge.getLocalStorage(KEY));
}

export interface UrlCheck {
  readonly valid: boolean;
  readonly error?: string;
}

/**
 * Plain http is expected, not merely tolerated: the ÖBB proxy runs on the
 * user's own phone or network, where there is no certificate to have.
 */
export function validateUrl(url: string, locale: Locale = "en"): UrlCheck {
  const trimmed = url.trim();
  if (!trimmed) return { valid: false, error: t(locale, "p.urlMissing") };
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, error: t(locale, "p.urlScheme") };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: t(locale, "p.urlInvalid") };
  }
}

export function parseSettings(raw: string, defaults: Settings = DEFAULT_SETTINGS): Settings {
  if (!raw) return defaults;
  try {
    const value = JSON.parse(raw) as Partial<Settings>;
    return {
      backend: value.backend === "oebb" || value.backend === "motis" ? value.backend : defaults.backend,
      oebbUrl: validateUrl(String(value.oebbUrl ?? "")).valid
        ? String(value.oebbUrl).trim() : defaults.oebbUrl,
      motisUrl: validateUrl(String(value.motisUrl ?? "")).valid
        ? String(value.motisUrl).trim() : defaults.motisUrl,
      sttUrl: validateUrl(String(value.sttUrl ?? "")).valid ? String(value.sttUrl).trim() : "",
      // A refresh faster than ten seconds hammers a service run by
      // volunteers without telling the user anything new — most feeds do not
      // update that often anyway.
      refreshSeconds: typeof value.refreshSeconds === "number"
        && value.refreshSeconds >= 10 && value.refreshSeconds <= 300
        ? Math.round(value.refreshSeconds)
        : defaults.refreshSeconds,
    };
  } catch {
    return defaults;
  }
}
