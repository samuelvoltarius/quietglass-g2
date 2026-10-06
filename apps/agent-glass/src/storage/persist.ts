import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

/**
 * Where Even Terminal runs, and the token to reach it.
 *
 * The token is a real credential: whoever holds it can run commands on the
 * machine at the other end. It is therefore never put in a log line, never
 * shown in full on the phone, and never rendered on the glasses.
 */

export type ProviderKind = "even-terminal" | "hermes" | "openclaw";

export interface Settings {
  readonly provider: ProviderKind;
  /** e.g. http://100.95.218.17:3456 */
  readonly baseUrl: string;
  readonly token: string;
  /** Session to reopen on start; empty means "ask". */
  readonly sessionId: string;
  /** Phone-side speech routed to the active speaker or Bluetooth headphones. */
  readonly spokenOutput: boolean;
  /** BCP-47 language tag, or "auto" for the phone language. */
  readonly speechLanguage: string;
  /** Browser-provided voice name; empty uses the best language match. */
  readonly speechVoice: string;
  readonly speechRate: number;
}

const KEY = "quietglass.agentglass.v1";

export const DEFAULT_SETTINGS: Settings = {
  provider: "even-terminal",
  baseUrl: "http://127.0.0.1:3456",
  token: "",
  sessionId: "",
  spokenOutput: false,
  speechLanguage: "auto",
  speechVoice: "",
  speechRate: 1,
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
    const provider = parseProvider(value.provider);
    const candidateUrl = String(value.baseUrl ?? "").trim();
    return {
      provider,
      baseUrl: validateProviderUrl(candidateUrl, provider).valid
        ? candidateUrl : defaultUrlForProvider(provider),
      token: typeof value.token === "string" ? value.token.trim() : "",
      sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
      spokenOutput: value.spokenOutput === true,
      speechLanguage: typeof value.speechLanguage === "string" && value.speechLanguage
        ? value.speechLanguage : "auto",
      speechVoice: typeof value.speechVoice === "string" ? value.speechVoice : "",
      speechRate: clampRate(value.speechRate),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function clampRate(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1.5, Math.max(0.7, value)) : 1;
}

export interface UrlCheck { readonly valid: boolean; readonly error?: string }

export function validateUrl(url: string): UrlCheck {
  const trimmed = url.trim();
  if (!trimmed) return { valid: false, error: "Address is required." };
  try {
    const parsed = new URL(trimmed);
    if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
      return { valid: false, error: "Address must start with http://, https://, ws:// or wss://." };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "This is not a valid address." };
  }
}

export function validateProviderUrl(url: string, provider: ProviderKind): UrlCheck {
  const base = validateUrl(url);
  if (!base.valid) return base;
  const protocol = new URL(url.trim()).protocol;
  const valid = provider === "hermes"
    ? protocol === "ws:" || protocol === "wss:"
    : protocol === "http:" || protocol === "https:";
  if (valid) return { valid: true };
  return { valid: false, error: provider === "hermes"
    ? "Hermes bridge addresses must start with ws:// or wss://."
    : "This provider address must start with http:// or https://." };
}

export function parseProvider(value: unknown): ProviderKind {
  return value === "hermes" || value === "openclaw" || value === "even-terminal"
    ? value : "even-terminal";
}

export function defaultUrlForProvider(provider: ProviderKind): string {
  if (provider === "hermes") return "ws://127.0.0.1:8765";
  if (provider === "openclaw") return "http://127.0.0.1:18789";
  return "http://127.0.0.1:3456";
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
