import type { AgentEvent, HistoryEntry } from "../terminal/types";

/**
 * The whole conversation of the open session, for the phone.
 *
 * The glasses keep showing only the current answer, condensed and paged; the
 * phone has room for everything that was said, newest at the bottom. Pure:
 * history plus live events in, entries out.
 */
export interface TranscriptEntry {
  readonly role: "user" | "assistant" | "tool" | "error";
  readonly text: string;
  /** Still growing from `text_delta` events. */
  readonly open?: boolean;
}

export type Transcript = readonly TranscriptEntry[];

/** Older entries are dropped beyond this; the phone stays responsive. */
export const MAX_ENTRIES = 200;
/** One runaway answer must not swallow the page. */
export const MAX_ENTRY_CHARS = 20000;

export function fromHistory(history: readonly HistoryEntry[]): Transcript {
  return cap(history.flatMap((entry): TranscriptEntry[] => {
    if (!entry.text.trim()) return [];
    if (entry.role === "user" || entry.role === "assistant") return [{ role: entry.role, text: clip(entry.text) }];
    return [];
  }));
}

/** Folds one live event into the transcript. */
export function applyTranscript(entries: Transcript, event: AgentEvent): Transcript {
  switch (event.kind) {
    case "user_prompt":
      return event.text.trim() ? cap([...closeAll(entries), { role: "user", text: clip(event.text) }]) : closeAll(entries);

    case "text_delta": {
      if (!event.text) return entries;
      const last = entries[entries.length - 1];
      if (last?.role === "assistant" && last.open) {
        return [...entries.slice(0, -1), { ...last, text: clip(last.text + event.text) }];
      }
      return cap([...entries, { role: "assistant", text: clip(event.text), open: true }]);
    }

    case "text": {
      if (!event.text.trim()) return entries;
      // A complete message. Any assistant part of this turn that it already
      // contains was a partial version of it (streamed deltas, or a bridge
      // that repeats the whole answer at the end): replace, do not repeat.
      const full = event.text;
      let start = entries.length;
      while (start > 0) {
        const entry = entries[start - 1];
        if (!entry || entry.role === "user") break;
        start -= 1;
      }
      const turn = entries.slice(start).filter((entry) =>
        !(entry.role === "assistant" && entry.text.trim() && full.includes(entry.text.trim())));
      return cap([...entries.slice(0, start), ...turn, { role: "assistant", text: clip(full) }]);
    }

    case "tool_start": {
      const name = event.tool ?? event.text;
      if (!name) return closeAll(entries);
      return cap([...closeAll(entries), { role: "tool", text: clip(name) }]);
    }

    case "result":
      return closeAll(entries);

    case "error":
      return cap([...closeAll(entries), { role: "error", text: clip(event.text || "Error") }]);

    default:
      return entries;
  }
}

function closeAll(entries: Transcript): Transcript {
  const last = entries[entries.length - 1];
  if (!last?.open) return entries;
  return [...entries.slice(0, -1), { role: last.role, text: last.text }];
}

function clip(text: string): string {
  return text.length <= MAX_ENTRY_CHARS ? text : `…${text.slice(text.length - MAX_ENTRY_CHARS + 1)}`;
}

function cap(entries: TranscriptEntry[] | Transcript): Transcript {
  return entries.length <= MAX_ENTRIES ? entries : entries.slice(entries.length - MAX_ENTRIES);
}
