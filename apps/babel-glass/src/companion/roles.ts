import type { BabelData } from "../storage/persist";
import type { SpeakerRole } from "../stt/role";
import { OWNER_SPEAKER } from "../stt/voice";

/**
 * 1.1.1: how Babel uses the glasses' speaker role ("Sprecher erkennen (Brille)").
 *
 * Order of trust: the voice profile (ECAPA on the speech server, "ME") wins
 * whenever it says something; the glasses' role decides only without one; a
 * line whose role is "unknown" is never dropped, it just carries no mark.
 */

/** The phone switch "Sprecher erkennen (Brille)"; absent = on, only `false` is stored. */
export function rolesOn(data: Pick<BabelData, "speakerRole">): boolean {
  return data.speakerRole !== false;
}

/** A voice profile is in force: the server names the user "ME" and letters are the others. */
export function profileActive(data: Pick<BabelData, "voiceEnrolled" | "speakers">): boolean {
  return data.voiceEnrolled && data.speakers;
}

/** What the voice profile says about one final line; null = no profile. */
export function profileVerdict(speaker: string | undefined, profile: boolean): "self" | "other" | "none" | null {
  if (!profile) return null;
  if (speaker === OWNER_SPEAKER) return "self";
  return speaker ? "other" : "none";
}

export type Who = { readonly kind: "me" } | { readonly kind: "them" } | { readonly kind: "letter"; readonly letter: string };

export interface WhoOptions {
  /** Speaker letters on (phone setting). */
  readonly speakers: boolean;
  /** Mark "Ich"/"Gegenüber" (Gespräch mode and the switch on). */
  readonly roles: boolean;
  /** A voice profile is in force. */
  readonly profile: boolean;
}

/**
 * The mark in front of a line, or null. With `roles` the line is "me" or
 * "them" (profile first, then the glasses' role); without, the old speaker
 * label ("ME" → me, a letter as is).
 */
export function lineWho(line: { readonly speaker?: string; readonly role?: SpeakerRole }, options: WhoOptions): Who | null {
  const letter = options.speakers && line.speaker ? line.speaker : undefined;
  if (letter === OWNER_SPEAKER) return { kind: "me" };
  if (options.roles) {
    if (options.profile && letter) return { kind: "them" };
    if (line.role === "self") return { kind: "me" };
    if (line.role === "other") return { kind: "them" };
  }
  return letter ? { kind: "letter", letter } : null;
}

/** Message key of a mark ("Ich" / "Ggü."), or the letter itself. */
export function whoLabel(who: Who, x: (key: string) => string): string {
  return who.kind === "me" ? x("g.me") : who.kind === "them" ? x("g.them") : who.letter;
}

export interface WordGate {
  /** The voice profile decides (existing 1.0.0 behaviour). */
  readonly profile: boolean;
  /** Without a profile: only lines the glasses classified "self" count. */
  readonly role: boolean;
}

/**
 * Which gate the word finder uses: the profile when there is one; else the
 * glasses' role when the switch is on and the glasses do classify (a frame
 * was self or other this session) – a host that always says "unknown" must
 * not silence the word finder; else none (the older letter / language guess).
 */
export function wordGate(input: { readonly profile: boolean; readonly rolesOn: boolean; readonly seenKnown: boolean }): WordGate {
  if (input.profile) return { profile: true, role: false };
  return { profile: false, role: input.rolesOn && input.seenKnown };
}
