import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

/**
 * Which backend to ask, and where it lives. Nothing else is kept.
 *
 * No journey history, no home stop, no favourites. Where somebody travels is
 * about as personal as data gets, and the only way to be sure it is not
 * leaked is not to hold it.
 */

export type BackendId = "oebb" | "motis";

export interface Settings {
  readonly backend: BackendId;
  /** Where the ÖBB proxy runs; see examples/. */
  readonly oebbUrl: string;
  /** Transitous, or your own MOTIS. */
  readonly motisUrl: string;
  /** Seconds between refreshes while a board is on screen. */
  readonly refreshSeconds: number;
}

const KEY = "quietglass.nextstop.v1";

/**
 * ÖBB is the default because this is where the app was built and verified,
 * and because in Austria it is the only one of the two that carries live
 * delays. Outside Austria it knows nothing, so the phone app says so.
 */
export const DEFAULT_SETTINGS: Settings = {
  backend: "oebb",
  oebbUrl: "http://127.0.0.1:8079/oebb",
  motisUrl: "https://api.transitous.org",
  refreshSeconds: 30,
};

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
export function validateUrl(url: string): UrlCheck {
  const trimmed = url.trim();
  if (!trimmed) return { valid: false, error: "Adresse fehlt." };
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, error: "Adresse muss mit http:// oder https:// beginnen." };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "Das ist keine gültige Adresse." };
  }
}

export function parseSettings(raw: string): Settings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const value = JSON.parse(raw) as Partial<Settings>;
    return {
      backend: value.backend === "motis" ? "motis" : "oebb",
      oebbUrl: validateUrl(String(value.oebbUrl ?? "")).valid
        ? String(value.oebbUrl).trim() : DEFAULT_SETTINGS.oebbUrl,
      motisUrl: validateUrl(String(value.motisUrl ?? "")).valid
        ? String(value.motisUrl).trim() : DEFAULT_SETTINGS.motisUrl,
      // A refresh faster than ten seconds hammers a service run by
      // volunteers without telling the user anything new — most feeds do not
      // update that often anyway.
      refreshSeconds: typeof value.refreshSeconds === "number"
        && value.refreshSeconds >= 10 && value.refreshSeconds <= 300
        ? Math.round(value.refreshSeconds)
        : DEFAULT_SETTINGS.refreshSeconds,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
