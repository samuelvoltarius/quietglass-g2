import type { Session } from "../terminal/types";
import type { ProviderKind } from "../storage/persist";
import type { Locale } from "../i18n";
import { t } from "../messages";

/**
 * The session list, as the glasses and the phone show it.
 *
 * Pure: what a backend reported plus what this phone remembers (a local name,
 * sessions taken off the list) goes in, the rows to show come out. None of the
 * three providers can rename or delete a session over its existing protocol,
 * so both are phone-side by default: a name given here only lives on this
 * phone, and "remove" only hides the session here. Nothing on the agent's
 * machine is ever deleted by Agent Glass (see `manage.ts`).
 */

/** What this phone remembers about sessions, keyed per provider (see `prefKey`). */
export interface SessionPrefs {
  /** `provider:id` → name given on the phone. */
  readonly names: Readonly<Record<string, string>>;
  /** `provider:id` of sessions taken off the list on this phone. */
  readonly hidden: readonly string[];
}

export const EMPTY_PREFS: SessionPrefs = { names: {}, hidden: [] };

/** Longest name accepted from the phone; the glasses cut it anyway. */
export const MAX_NAME = 80;

export function prefKey(provider: ProviderKind, id: string): string {
  return `${provider}:${id}`;
}

/**
 * Applies local names, drops hidden sessions and sorts the newest first.
 * The backend's order is not trusted: Even Terminal lists by directory.
 */
export function prepareSessions(
  sessions: readonly Session[], prefs: SessionPrefs, provider: ProviderKind,
): readonly Session[] {
  const hidden = new Set(prefs.hidden);
  return sessions
    .filter((session) => !hidden.has(prefKey(provider, session.id)))
    .map((session) => {
      const name = prefs.names[prefKey(provider, session.id)];
      return name ? { ...session, title: name } : session;
    })
    .map((session, index) => ({ session, index }))
    .sort((a, b) => (time(b.session) - time(a.session)) || (a.index - b.index))
    .map(({ session }) => session);
}

function time(session: Session): number {
  const value = session.timestamp instanceof Date ? session.timestamp.getTime() : NaN;
  return Number.isFinite(value) ? value : 0;
}

/** How long ago, in a few characters: "jetzt", "5 min", "3 h", "2 d". Empty when unknown. */
export function ageLabel(timestamp: Date | undefined, now: Date, locale: Locale = "en"): string {
  const value = timestamp instanceof Date ? timestamp.getTime() : NaN;
  if (!Number.isFinite(value) || value <= 0) return "";
  const seconds = Math.max(0, Math.round((now.getTime() - value) / 1000));
  if (seconds < 90) return t(locale, "g.ageNow");
  if (seconds < 90 * 60) return t(locale, "g.ageMin", { n: Math.round(seconds / 60) });
  if (seconds < 36 * 3600) return t(locale, "g.ageHour", { n: Math.round(seconds / 3600) });
  return t(locale, "g.ageDay", { n: Math.round(seconds / 86400) });
}

/** One selectable row of the list on the glasses. */
export type SessionRow =
  | { readonly kind: "new" }
  | { readonly kind: "session"; readonly session: Session }
  /** The last root entry: the help page (the side menu is off, see SIDE_MENU in main.ts). */
  | { readonly kind: "help" };

/** "+ New session" comes first when the backend can start one, then the sessions, then "Hilfe". */
export function sessionRows(sessions: readonly Session[], canCreate: boolean): readonly SessionRow[] {
  const rows: SessionRow[] = canCreate ? [{ kind: "new" }] : [];
  for (const session of sessions) rows.push({ kind: "session", session });
  rows.push({ kind: "help" });
  return rows;
}

/** Cleans a name typed on the phone; empty means "back to the agent's own title". */
export function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

export function withName(prefs: SessionPrefs, key: string, name: string): SessionPrefs {
  const names = { ...prefs.names };
  const clean = cleanName(name);
  if (clean) names[key] = clean;
  else delete names[key];
  return { ...prefs, names };
}

export function withHidden(prefs: SessionPrefs, key: string): SessionPrefs {
  return prefs.hidden.includes(key) ? prefs : { ...prefs, hidden: [...prefs.hidden, key] };
}

/** Brings back every session hidden for one provider. */
export function withoutHidden(prefs: SessionPrefs, provider: ProviderKind): SessionPrefs {
  return { ...prefs, hidden: prefs.hidden.filter((key) => !key.startsWith(`${provider}:`)) };
}

export function hiddenCount(prefs: SessionPrefs, provider: ProviderKind): number {
  return prefs.hidden.filter((key) => key.startsWith(`${provider}:`)).length;
}

/** Reads stored prefs defensively; anything malformed is dropped, not trusted. */
export function parsePrefs(value: unknown): SessionPrefs {
  const record = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const names: Record<string, string> = {};
  const rawNames = record["names"];
  if (rawNames !== null && typeof rawNames === "object") {
    for (const [key, name] of Object.entries(rawNames as Record<string, unknown>)) {
      if (typeof name === "string" && cleanName(name)) names[key] = cleanName(name);
    }
  }
  const rawHidden = record["hidden"];
  const hidden = Array.isArray(rawHidden)
    ? [...new Set(rawHidden.filter((key): key is string => typeof key === "string" && key.length > 0))]
    : [];
  return { names, hidden };
}
