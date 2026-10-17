import type { BabelData } from "../storage/persist";
import type { ReplyTiming } from "./replies";

/**
 * 0.6.3: two modes on the glasses.
 * "client" (Kundengespräch): German captions only, source forced to "de"
 * ("auto" makes the recogniser invent English sentences on noise), no
 * translation at all, faster reply suggestions.
 * "translate" (Übersetzen): exactly the behaviour before 0.6.3.
 * 1.0.0 "learn" (Englisch sprechen): the user practises English: English captions of
 * what is said, the automatic word finder always on, the other person optionally
 * translated into German (phone switch `learnTranslate`).
 */
export type TalkMode = "client" | "translate" | "learn";

/** The language the recogniser is told in client mode. */
export const CLIENT_LANGUAGE = "de";

/** The languages "Englisch sprechen" works in: the conversation and the translation of the other person. */
export const LEARN_LANGUAGE = "en";
export const LEARN_TARGET = "de";

/** Reply suggestion timing in client mode; translate mode keeps the watcher defaults. */
export const CLIENT_REPLY_TIMING: ReplyTiming = { debounceMs: 600, minGapMs: 8_000, requestGapMs: 2_500 };

/** The mode in force: the user's pick, else client when Shoot Day reports a customer, else translate. */
export function effectiveTalkMode(data: BabelData, customerActive: boolean): TalkMode {
  if (data.talkMode === "client" || data.talkMode === "translate" || data.talkMode === "learn") return data.talkMode;
  return customerActive ? "client" : "translate";
}

/**
 * The settings as the running captions use them: in client mode the source is
 * German and translation is off (translationEnabled() reads `talkMode`).
 */
export function modeData(data: BabelData, customerActive: boolean): BabelData {
  const mode = effectiveTalkMode(data, customerActive);
  if (mode === "learn") return { ...data, talkMode: "learn", sourceLanguage: LEARN_LANGUAGE, targetLanguage: LEARN_TARGET };
  return mode === "client"
    ? { ...data, talkMode: "client", sourceLanguage: CLIENT_LANGUAGE }
    : { ...data, talkMode: "translate" };
}

/** Reply timing for the mode; undefined = the watcher's own defaults. */
export function replyTimingFor(mode: TalkMode): ReplyTiming | undefined {
  return mode === "client" ? CLIENT_REPLY_TIMING : undefined;
}

/** Message key of the mode's name ("Kundengespräch" / "Übersetzen"). */
export function talkModeKey(mode: TalkMode): string {
  return mode === "client" ? "g.mode.client" : mode === "learn" ? "g.mode.learn" : "g.mode.translate";
}
