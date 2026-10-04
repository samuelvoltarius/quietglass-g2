import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

/**
 * Where Even Terminal runs, and the token to reach it.
 *
 * The token is a real credential: whoever holds it can run commands on the
 * machine at the other end. It is therefore never put in a log line, never
 * shown in full on the phone, and never rendered on the glasses.
 */

export interface Settings {
  /** e.g. http://100.95.218.17:3456 */
  readonly baseUrl: string;
  readonly token: string;
  /** Session to reopen on start; empty means "ask". */
  readonly sessionId: string;
}

const KEY = "quietglass.agentglass.v1";

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: "http://127.0.0.1:3456",
  token: "",
  sessionId: "",
};

export async function save(bridge: EvenAppBridge, settings: Settings): Promise<void> {
  await bridge.setLocalStorage(KEY, JSON.stringify(settings));
}

export async function load(bridge: EvenAppBridge): Promise<Settings> {
  return parseSettings(await bridge.getLocalStorage(KEY));
}

export function parseSettings(raw: string): Settings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const value = JSON.parse(raw) as Partial<Settings>;
    return {
      baseUrl: validateUrl(String(value.baseUrl ?? "")).valid
        ? String(value.baseUrl).trim() : DEFAULT_SETTINGS.baseUrl,
      token: typeof value.token === "string" ? value.token.trim() : "",
      sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export interface UrlCheck { readonly valid: boolean; readonly error?: string }

export function validateUrl(url: string): UrlCheck {
  const trimmed = url.trim();
  if (!trimmed) return { valid: false, error: "Address is required." };
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, error: "Address must start with http:// or https://." };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "This is not a valid address." };
  }
}

/**
 * Accepts the pairing URL Even Terminal prints, so the whole thing can be
 * pasted in one go instead of split by hand.
 *
 *   http://100.95.218.17:3456?token=abc…&defaultProvider=claude
 */
export function parsePairingUrl(input: string): { baseUrl: string; token: string } | null {
  try {
    const url = new URL(input.trim());
    const token = url.searchParams.get("token");
    if (!token) return null;
    return { baseUrl: `${url.protocol}//${url.host}`, token };
  } catch {
    return null;
  }
}

/** Shows that a token exists without revealing it. */
export function maskToken(token: string): string {
  if (!token) return "none";
  return `set (${token.length} characters, ends in ${token.slice(-4)})`;
}
