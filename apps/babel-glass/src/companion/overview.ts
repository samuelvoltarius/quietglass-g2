import type { SttStatus } from "../stt/provider";
import type { BabelData } from "../storage/persist";

/**
 * What the phone needs to know about the running state (0.5.0 "Übersicht"; 1.0.0: the table and the
 * glasses help are gone, what is left is the state and the language pair).
 */

/** Babel's own memory as last seen (probe, search, store). */
export type MemoryStatus = "unknown" | "ok" | "unavailable" | "unauthorized";

/** Boolean settings a helper row can switch. */
export type HelperToggle = "speakers" | "insights" | "replySuggestions" | "translateOwn" | "keepTranscript" | "autoSummary" | "memory" | "wordAuto";

export interface OverviewInput {
  readonly data: BabelData;
  readonly listening: boolean;
  readonly sttStatus: SttStatus;
  readonly memory: MemoryStatus;
}
