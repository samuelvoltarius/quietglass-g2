import type { Locale } from "../i18n";
import { chatCompletionsUrl } from "../translate/provider";
import { streamChat } from "../llm/stream";
import { partialJsonString } from "../llm/partial-json";
import { speakerLine, transcriptForLlm, type TranscriptEntry } from "./transcript";

/**
 * The conversation companion's language-model calls: a summary at the end and
 * short explanations ("popups") for questions or unusual terms during the
 * conversation. Same OpenAI-compatible server as the translation (your own
 * vLLM/Ollama/…); nothing here searches the web.
 */

export interface Summary {
  /** At most three short lines for the glasses. */
  readonly short: string[];
  /** The detailed version for the phone, one point per line. */
  readonly long: string[];
  /** Abmachungen / agreements (who does what by when), kept in Babel's own memory. Absent = none. */
  readonly agreements?: string[];
}

export interface Insight {
  /** The question or term, short. */
  readonly term: string;
  /** The explanation, about one or two sentences. */
  readonly info: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface CompanionLlm {
  readonly name: string;
  /** `onProgress` (optional) receives the summary so far while it is being written. */
  /** `extra`: text appended after the transcript (the tip cards shown during the conversation). */
  summarize(log: readonly TranscriptEntry[], locale: Locale, onProgress?: (partial: Summary) => void, extra?: string): Promise<Result<Summary>>;
  /**
   * null = nothing worth explaining in the newest lines. `onProgress` gets the
   * explanation while it is written, once its term is complete.
   */
  explain(
    recent: readonly TranscriptEntry[],
    known: readonly string[],
    locale: Locale,
    onProgress?: (partial: Insight) => void,
    /** Hits from Babel's own memory for the current topic, already formatted ("Notizen des Nutzers"). */
    notes?: string,
  ): Promise<Result<Insight | null>>;
}

export interface CompanionLlmConfig {
  readonly url: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  /** Hard cap for one summary (prompt processing + writing). */
  readonly summaryTimeoutMs?: number;
  readonly explainTimeoutMs?: number;
}

/**
 * Output budgets. A detailed summary of a long conversation is easily 1500
 * tokens of German; the old 900 cut it off mid-JSON. Explanations are short
 * by prompt, the cap only stops a runaway answer.
 */
export const SUMMARY_MAX_TOKENS = 3000;
export const EXPLAIN_MAX_TOKENS = 320;
/**
 * Transcript characters sent for a summary (~16k tokens): far below the
 * 64k context of the Spark model, and the newest part is kept when cut.
 */
export const SUMMARY_TRANSCRIPT_CHARS = 48_000;

export function summaryPrompt(locale: Locale): string {
  return locale === "de"
    ? [
        "Du fasst ein mitgeschriebenes Gespräch auf Deutsch zusammen.",
        "Die Mitschrift stammt aus automatischer Spracherkennung und kann Hörfehler enthalten; A:, B: … sind Sprecher.",
        "Antworte NUR mit JSON:",
        '{"kurz":"höchstens 3 sehr kurze Zeilen, getrennt durch \\n, je höchstens 45 Zeichen",',
        '"lang":"ausführliche Zusammenfassung: Thema, wichtigste Punkte, Entscheidungen, offene Fragen, Aufgaben (wer, was, wann); jede Zeile beginnt mit - , getrennt durch \\n",',
        '"abmachungen":"nur feste Abmachungen/Zusagen (wer, was, bis wann), getrennt durch \\n; leer, wenn es keine gab"}',
        "Nichts erfinden, kein Markdown.",
      ].join(" ")
    : [
        "Summarise a transcribed conversation in English.",
        "The transcript comes from automatic speech recognition and may contain errors; A:, B: … are speakers.",
        "Reply ONLY with JSON:",
        '{"kurz":"at most 3 very short lines separated by \\n, each at most 45 characters",',
        '"lang":"detailed summary: topic, main points, decisions, open questions, tasks (who, what, when); every line starts with - , separated by \\n",',
        '"abmachungen":"only firm agreements/commitments (who, what, by when), separated by \\n; empty if there were none"}',
        "Do not invent anything, no Markdown.",
      ].join(" ");
}

/**
 * With notes (Babel's own memory, 0.4.0) the model may also point out a past
 * note that concretely fits the newest line. With nothing to say it answers
 * exactly "-", which shows nothing.
 */
export function explainPrompt(locale: Locale, known: readonly string[], withNotes = false): string {
  const base = explainBase(locale, known);
  if (!withNotes) return base;
  return base + " " + (locale === "de"
    ? [
        "Unter „Notizen des Nutzers“ stehen frühere Gespräche und Notizen.",
        "Passt eine davon KONKRET zur letzten Zeile (gleiche Person, gleiches Thema, eine frühere Abmachung),",
        'darfst du statt einer Erklärung daran erinnern: {"begriff":"Notiz: Stichwort","info":"was damals war oder vereinbart wurde"}.',
        "Nur vage ähnlich zählt nicht. Ist weder etwas zu erklären noch eine Notiz konkret passend, antworte genau -",
      ].join(" ")
    : [
        "Under \"Notizen des Nutzers\" (the user's notes) are earlier conversations and notes.",
        "If one fits the last line CONCRETELY (same person, same topic, an earlier agreement),",
        'you may remind of it instead of explaining: {"begriff":"Note: keyword","info":"what was said or agreed then"}.',
        "Merely similar does not count. If there is nothing to explain and no note fits concretely, answer exactly -",
      ].join(" "));
}

function explainBase(locale: Locale, known: readonly string[]): string {
  const already = known.length ? known.slice(-12).join(", ") : "";
  return locale === "de"
    ? [
        "Du hilfst jemandem live in einem Gespräch (Mitschrift per Spracherkennung, A:/B: = Sprecher).",
        "Prüfe NUR die letzte Zeile: Enthält sie eine Sachfrage, die man mit Allgemeinwissen kurz beantworten kann,",
        "oder einen Fachbegriff/eine Abkürzung, die nicht jeder kennt?",
        'Dann antworte NUR mit JSON {"begriff":"Frage oder Begriff, höchstens 30 Zeichen","info":"Antwort oder Erklärung auf Deutsch, höchstens 140 Zeichen"}.',
        'Sonst antworte NUR {"keine":true}. Nichts erfinden; bei Unsicherheit {"keine":true}.',
        already ? "Schon erklärt (nicht wiederholen): " + already + "." : "",
      ].join(" ").trim()
    : [
        "You help someone live during a conversation (speech-recognition transcript, A:/B: = speakers).",
        "Look ONLY at the last line: does it contain a factual question that general knowledge answers briefly,",
        "or a technical term/abbreviation not everyone knows?",
        'Then reply ONLY with JSON {"begriff":"question or term, at most 30 characters","info":"answer or explanation in English, at most 140 characters"}.',
        'Otherwise reply ONLY {"keine":true}. Do not invent; when unsure {"keine":true}.',
        already ? "Already explained (do not repeat): " + already + "." : "",
      ].join(" ").trim();
}

/** The first JSON object in a model reply (tolerates fences, preambles, <think> blocks). */
export function extractJson(content: string): Record<string, unknown> | null {
  const text = content.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const lines = (text: string): string[] =>
  text.split(/\n+/).map((line) => line.replace(/^\s*[-•*]\s*/, "").trim()).filter(Boolean);

export function parseSummary(content: string): Summary | null {
  const json = extractJson(content);
  if (json) {
    const short = typeof json["kurz"] === "string" ? lines(json["kurz"]) : [];
    const long = typeof json["lang"] === "string" ? lines(json["lang"]) : [];
    if (short.length || long.length) {
      const raw = json["abmachungen"];
      const agreements = typeof raw === "string" ? lines(raw)
        : Array.isArray(raw) ? raw.filter((a): a is string => typeof a === "string").flatMap(lines)
        : [];
      return {
        short: (short.length ? short : long).slice(0, 3),
        long: long.length ? long : short,
        ...(agreements.length ? { agreements: agreements.slice(0, 20) } : {}),
      };
    }
  }
  // Not JSON: use the text as it is, the first lines for the glasses.
  const plain = lines(content.replace(/<think>[\s\S]*?<\/think>/gi, ""));
  return plain.length ? { short: plain.slice(0, 3), long: plain } : null;
}

export function parseInsight(content: string): Insight | null {
  // "-" = nothing worth showing (what the memory-aware prompt asks for).
  if (content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() === "-") return null;
  const json = extractJson(content);
  if (!json || json["keine"] === true) return null;
  const term = typeof json["begriff"] === "string" ? json["begriff"].trim() : "";
  const info = typeof json["info"] === "string" ? json["info"].trim() : "";
  if (!term || !info) return null;
  return { term: term.slice(0, 60), info: info.slice(0, 280) };
}

/** Removes reasoning and a leading code fence, for reading a growing answer. */
function growingText(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^\s*```[a-z]*\s*/i, "");
}

/** The summary while it is still being written (JSON fields read as they grow). */
export function partialSummary(content: string): Summary | null {
  const text = growingText(content);
  const short = partialJsonString(text, "kurz");
  const long = partialJsonString(text, "lang");
  if (short || long) {
    const s = short ? lines(short.value) : [];
    const l = long ? lines(long.value) : [];
    return s.length || l.length ? { short: s.slice(0, 3), long: l } : null;
  }
  // Still in "{", or a model that answers in plain lines.
  const trimmed = text.trimStart();
  if (trimmed === "" || trimmed.startsWith("{")) return null;
  const plain = lines(trimmed);
  return plain.length ? { short: plain.slice(0, 3), long: plain } : null;
}

/** The explanation while it is written: only once the term is complete. */
export function partialInsight(content: string): Insight | null {
  const text = growingText(content);
  const term = partialJsonString(text, "begriff");
  if (!term?.complete || !term.value.trim()) return null;
  const info = partialJsonString(text, "info");
  if (!info || !info.value.trim()) return null;
  return { term: term.value.trim().slice(0, 60), info: info.value.trim().slice(0, 280) };
}

export function createCompanionLlm(config: CompanionLlmConfig): CompanionLlm {
  const endpoint = chatCompletionsUrl(config.url);

  const chat = (
    system: string,
    user: string,
    maxTokens: number,
    timing: { readonly firstTokenMs: number; readonly idleMs: number; readonly totalMs: number },
    onText?: (visible: string) => void,
  ): Promise<Result<string>> =>
    streamChat({
      endpoint,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
      ...(onText ? { onText } : {}),
      body: {
        model: config.model,
        temperature: 0.2,
        max_tokens: maxTokens,
        // Qwen-style reasoning off: answers must be quick and plain.
        chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      },
      ...timing,
    }).then((result) => (result.ok ? { ok: true as const, value: result.text } : result));

  return {
    name: "openai",
    async summarize(log, locale, onProgress, extra) {
      if (log.length === 0) return { ok: false, error: "empty" };
      const total = config.summaryTimeoutMs ?? 240_000;
      const reply = await chat(
        summaryPrompt(locale),
        transcriptForLlm(log, SUMMARY_TRANSCRIPT_CHARS) + (extra ?? ""),
        SUMMARY_MAX_TOKENS,
        // A long transcript takes a while before the first word; then it flows.
        { firstTokenMs: Math.min(total, 90_000), idleMs: 30_000, totalMs: total },
        onProgress ? (visible) => { const partial = partialSummary(visible); if (partial) onProgress(partial); } : undefined,
      );
      if (!reply.ok) return reply;
      const summary = parseSummary(reply.value);
      return summary ? { ok: true, value: summary } : { ok: false, error: "empty response" };
    },
    async explain(recent, known, locale, onProgress, notes) {
      if (recent.length === 0) return { ok: true, value: null };
      const conversation = recent.map(speakerLine).join("\n");
      const withNotes = Boolean(notes?.trim());
      const user = withNotes
        ? "Notizen des Nutzers:\n" + notes!.trim() + "\n\n" + (locale === "de" ? "Gespräch:\n" : "Conversation:\n") + conversation
        : conversation;
      const wait = config.explainTimeoutMs ?? 12_000;
      const reply = await chat(
        explainPrompt(locale, known, withNotes),
        user,
        EXPLAIN_MAX_TOKENS,
        { firstTokenMs: wait, idleMs: Math.min(wait, 8_000), totalMs: wait * 2 },
        onProgress ? (visible) => { const partial = partialInsight(visible); if (partial) onProgress(partial); } : undefined,
      );
      if (!reply.ok) return reply;
      return { ok: true, value: parseInsight(reply.value) };
    },
  };
}

/**
 * Demo companion for the simulator (no server): explains the term in the demo
 * dialogue and writes a fixed summary. Only ever used together with the demo
 * recogniser, which is labelled DEMO on the glasses.
 */
export function createMockCompanion(): CompanionLlm {
  return {
    name: "mock",
    async summarize(log, locale) {
      const n = log.length;
      return locale === "de"
        ? { ok: true, value: {
            short: ["Demo: Projekt kurz besprochen", "Abnahme Dienstag 10 Uhr", "JAZ erklärt"],
            long: [`Demo-Zusammenfassung über ${n} Zeilen (ohne Server).`, "Thema: das Projekt.", "Termin: Abnahme am Dienstag um 10 Uhr.", "Frage: Was bedeutet JAZ? → Jahresarbeitszahl."],
          } }
        : { ok: true, value: {
            short: ["Demo: project discussed", "Handover Tuesday 10 am", "COP explained"],
            long: [`Demo summary of ${n} lines (no server).`, "Topic: the project.", "Date: handover on Tuesday at 10 am.", "Question: what is COP? → coefficient of performance."],
          } };
    },
    async explain(recent, known, locale) {
      const last = recent[recent.length - 1]?.text ?? "";
      if (/\bJAZ\b/.test(last) && !known.includes("JAZ")) {
        return { ok: true, value: { term: "JAZ", info: "Jahresarbeitszahl: erzeugte Wärme pro eingesetzter Strommenge im Jahr; über 4 gilt als gut. (Demo)" } };
      }
      if (/\bCOP\b/.test(last) && !known.includes("COP")) {
        return { ok: true, value: { term: "COP", info: "Coefficient of performance: heat delivered per unit of electricity; above 4 is good. (demo)" } };
      }
      void locale;
      return { ok: true, value: null };
    },
  };
}
