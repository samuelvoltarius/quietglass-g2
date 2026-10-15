import type { ProviderKind } from "../storage/persist";
import { cleanName, prefKey, withHidden, withName, type SessionPrefs } from "./model";

/**
 * Rename and remove, from the phone.
 *
 * A backend that can really rename or delete a session says so by having the
 * method; then the change happens on the agent's machine. None of the current
 * providers can (the Hermes bridge speaks `sessions.list/new/switch` only,
 * Even Terminal and OpenClaw have no such call), so the fallback is local and
 * honest: the name lives on this phone, and "remove" hides the session here
 * while the agent keeps it. Hidden sessions can be brought back.
 */
export interface SessionManager {
  renameSession?(id: string, title: string): Promise<void>;
  deleteSession?(id: string): Promise<void>;
}

export type Where = "remote" | "local";

export interface ManageResult {
  readonly prefs: SessionPrefs;
  readonly where: Where;
}

export function manageMode(backend: SessionManager): { readonly rename: Where; readonly remove: Where } {
  return {
    rename: typeof backend.renameSession === "function" ? "remote" : "local",
    remove: typeof backend.deleteSession === "function" ? "remote" : "local",
  };
}

export async function renameSession(
  backend: SessionManager, prefs: SessionPrefs, provider: ProviderKind, id: string, title: string,
): Promise<ManageResult> {
  const key = prefKey(provider, id);
  const clean = cleanName(title);
  if (backend.renameSession && clean) {
    await backend.renameSession(id, clean);
    // The agent now carries the name itself; a stale local one would hide it.
    return { prefs: withName(prefs, key, ""), where: "remote" };
  }
  return { prefs: withName(prefs, key, clean), where: "local" };
}

export async function removeSession(
  backend: SessionManager, prefs: SessionPrefs, provider: ProviderKind, id: string,
): Promise<ManageResult> {
  if (backend.deleteSession) {
    await backend.deleteSession(id);
    return { prefs: withName(prefs, prefKey(provider, id), ""), where: "remote" };
  }
  return { prefs: withHidden(prefs, prefKey(provider, id)), where: "local" };
}
