import type { Locale } from "../i18n";
import type { GuideState } from "../route/guide";
import { departureOf } from "../route/journey";
import type { TurnType, WalkNav } from "../route/walk";
import { minutesUntil } from "../transit/types";
import { rideStopName } from "../glasses/view";

/**
 * What the companion says out loud on a journey: turns on foot ("In 60 metres
 * turn left"), the vehicle at the stop ("Bus 3 in 2 minutes"), the ride
 * ("Get off at the next stop") and the goal. Pure logic: it is given the
 * guide's state after every GPS fix or tick, remembers what it already said
 * and returns at most one announcement per call (the next call brings the
 * next one). Nothing here knows about audio.
 */

/** Warn this far ahead of a turn on foot, and again just before it. */
export const WALK_FAR_METRES = 60;
export const WALK_NEAR_METRES = 15;

export interface Announcement {
  readonly text: string;
  /** 1 information, 2 act soon, 3 act now (get off, arrived). */
  readonly priority: number;
  /** A newer announcement with the same key replaces a queued older one. */
  readonly key: string;
  /** Not worth saying anymore after this long (ms). */
  readonly maxAgeMs: number;
}

export interface CompanionInput {
  /** Changes with every new journey; the memory starts over. */
  readonly journeyId: number;
  readonly state: GuideState;
  readonly now: Date;
  readonly walk: WalkNav | null;
  readonly locale: Locale;
  /** A GPS fix exists (walking turns need one). */
  readonly hasFix: boolean;
}

const TURN: Readonly<Record<Locale, Partial<Record<TurnType, string>>>> = {
  de: {
    left: "links abbiegen", slightLeft: "leicht links halten", sharpLeft: "scharf links abbiegen",
    right: "rechts abbiegen", slightRight: "leicht rechts halten", sharpRight: "scharf rechts abbiegen",
    uturn: "wenden", roundabout: "in den Kreisverkehr",
  },
  en: {
    left: "turn left", slightLeft: "keep slightly left", sharpLeft: "turn sharp left",
    right: "turn right", slightRight: "keep slightly right", sharpRight: "turn sharp right",
    uturn: "make a U-turn", roundabout: "enter the roundabout",
  },
};

/** 58 m reads as "60". */
export function spokenMeters(meters: number): number {
  if (meters >= 100) return Math.round(meters / 50) * 50;
  return Math.max(10, Math.round(meters / 10) * 10);
}

function minutesWord(locale: Locale, minutes: number): string {
  if (locale === "de") return minutes === 1 ? "einer Minute" : `${minutes} Minuten`;
  return minutes === 1 ? "one minute" : `${minutes} minutes`;
}

export class Companion {
  #journey = -1;
  readonly #said = new Set<string>();

  reset(): void { this.#journey = -1; this.#said.clear(); }

  /** True the first time `id` is asked for. */
  #once(id: string): boolean {
    if (this.#said.has(id)) return false;
    this.#said.add(id);
    return true;
  }

  next(input: CompanionInput): Announcement | null {
    if (input.journeyId !== this.#journey) { this.#journey = input.journeyId; this.#said.clear(); }
    const { state, locale } = input;
    const de = locale === "de";
    const step = state.step;
    const tag = `${state.index}`;

    if (state.phase === "arrived") {
      if (!this.#once("arrived")) return null;
      return { text: de ? "Sie haben Ihr Ziel erreicht." : "You have arrived.", priority: 3, key: "arrived", maxAgeMs: 15_000 };
    }

    if (step.kind === "walk") return this.#walk(input, tag);
    if (step.kind !== "transit") return null;

    const leg = step.leg;
    const stopName = rideStopName(leg.stops[leg.stops.length - 1]?.stop.name ?? "");

    if (state.phase === "missed") {
      if (!this.#once(`${tag}:missed`)) return null;
      return {
        text: de ? `${leg.line} ist weg. Bitte neu planen.` : `You missed ${leg.line}. Please plan again.`,
        priority: 3, key: `${tag}:missed`, maxAgeMs: 20_000,
      };
    }

    if (state.phase === "board") {
      const minutes = minutesUntil(departureOf(leg), input.now);
      const name = `${leg.line} ${de ? "Richtung" : "towards"} ${leg.headsign}`;
      const entry = this.#once(`${tag}:entry`);
      if (entry) {
        // Whatever the entry message already told, the later stages need not repeat.
        if (minutes <= 2) this.#said.add(`${tag}:two`);
        if (minutes <= 0) this.#said.add(`${tag}:now`);
        const prefix = step.transfer ? (de ? "Umsteigen: " : "Change: ") : "";
        const track = leg.boardTrack ? (de ? `, Gleis ${leg.boardTrack}` : `, platform ${leg.boardTrack}`) : "";
        const when = minutes <= 0
          ? (de ? "fährt jetzt ab" : "is leaving now")
          : `in ${minutesWord(locale, minutes)}`;
        return { text: `${prefix}${name} ${when}${track}.`, priority: 2, key: `${tag}:board`, maxAgeMs: 20_000 };
      }
      if (minutes <= 0 && this.#once(`${tag}:now`)) {
        return { text: de ? `${leg.line} kommt jetzt.` : `${leg.line} is arriving now.`, priority: 3, key: `${tag}:board`, maxAgeMs: 10_000 };
      }
      if (minutes <= 2 && minutes > 0 && this.#once(`${tag}:two`)) {
        return { text: `${leg.line} in ${minutesWord(locale, minutes)}.`, priority: 2, key: `${tag}:board`, maxAgeMs: 15_000 };
      }
      return null;
    }

    // Riding.
    const left = state.stopsLeft ?? 1;
    const after = step.after;
    const onward = after?.kind === "transit"
      ? after.leg.line
      : after?.kind === "walk" && after.next ? after.next.line : null;
    const onwardText = onward ? (de ? ` Weiter mit ${onward}.` : ` Continue with ${onward}.`) : "";
    if (left <= 1) {
      // The earlier stages are moot once the last stop is next.
      this.#said.add(`${tag}:alight2`);
      this.#said.add(`${tag}:ride`);
      if (this.#once(`${tag}:alight1`)) {
        return {
          text: de ? `Nächster Halt aussteigen: ${stopName}.${onwardText}` : `Next stop, get off: ${stopName}.${onwardText}`,
          priority: 3, key: `${tag}:alight`, maxAgeMs: 20_000,
        };
      }
      if (state.progress?.arriving && this.#once(`${tag}:alightNow`)) {
        return { text: de ? "Jetzt aussteigen." : "Get off now.", priority: 3, key: `${tag}:alight`, maxAgeMs: 10_000 };
      }
      return null;
    }
    if (left === 2) {
      this.#said.add(`${tag}:ride`);
      if (this.#once(`${tag}:alight2`)) {
        return {
          text: de ? `In zwei Halten aussteigen: ${stopName}.` : `Get off in two stops: ${stopName}.`,
          priority: 2, key: `${tag}:alight`, maxAgeMs: 30_000,
        };
      }
      return null;
    }
    if (this.#once(`${tag}:ride`)) {
      return {
        text: de ? `Aussteigen in ${left} Halten: ${stopName}.` : `Get off in ${left} stops: ${stopName}.`,
        priority: 1, key: `${tag}:ride`, maxAgeMs: 30_000,
      };
    }
    return null;
  }

  #walk(input: CompanionInput, tag: string): Announcement | null {
    const { state, locale, walk } = input;
    const de = locale === "de";
    const step = state.step;
    if (step.kind !== "walk" || !input.hasFix || !walk) return null;
    const leg = step.leg;
    const turn = walk.next;
    const legKey = `${tag}:${turn.shapeIndex}:${turn.type}`;
    const arriving = turn.type === "arrive";
    const phrase = TURN[locale][turn.type] ?? "";
    if (!arriving && phrase === "") return null;
    const destination = leg.toDestination ? leg.toName : rideStopName(leg.toName);

    if (walk.toNext <= WALK_NEAR_METRES) {
      this.#said.add(`${legKey}:far`);
      // The arrival itself is announced by the next step ("Bus 3 in 2 minutes" / goal reached).
      if (arriving || !this.#once(`${legKey}:near`)) return null;
      const text = de ? `Jetzt ${phrase}.` : `${phrase.replace(/^./, (c) => c.toUpperCase())} now.`;
      return { text, priority: 2, key: legKey, maxAgeMs: 6_000 };
    }
    if (walk.toNext <= WALK_FAR_METRES && this.#once(`${legKey}:far`)) {
      const meters = spokenMeters(walk.toNext);
      const street = !arriving && turn.street ? (de ? ` auf ${turn.street}` : ` onto ${turn.street}`) : "";
      const text = arriving
        ? (de ? `In ${meters} Metern erreichen Sie ${destination}.` : `In ${meters} meters you reach ${destination}.`)
        : (de ? `In ${meters} Metern ${phrase}${street}.` : `In ${meters} meters ${phrase}${street}.`);
      return { text, priority: 1, key: legKey, maxAgeMs: 10_000 };
    }
    return null;
  }
}
