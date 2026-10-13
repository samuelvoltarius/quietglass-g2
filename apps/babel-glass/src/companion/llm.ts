import type { Locale } from "../i18n";
import { chatCompletionsUrl, describeError, readChatContent } from "../translate/provider";
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
  summarize(log: readonly TranscriptEntry[], locale: Locale): Promise<Result<Summary>>;
  /** null = nothing worth explaining in the newest lines. */
  explain(recent: readonly TranscriptEntry[], known: readonly string[], locale: Locale): Promise<Result<Insight | null>>;
}

export interface CompanionLlmConfig {
  readonly url: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly summaryTimeoutMs?: number;
  readonly explainTimeoutMs?: number;
}

export function summaryPrompt(locale: Locale): string {
  return locale === "de"
    ? [
        "Du fasst ein mitgeschriebenes Gespräch auf Deutsch zusammen.",
        "Die Mitschrift stammt aus automatischer Spracherkennung und kann Hörfehler enthalten; A:, B: … sind Sprecher.",
        "Antworte NUR mit JSON:",
        '{"kurz":"höchstens 3 sehr kurze Zeilen, getrennt durch \\n, je höchstens 45 Zeichen",',
        '"lang":"ausführliche Zusammenfassung: Thema, wichtigste Punkte, Entscheidungen, offene Fragen, Aufgaben (wer, was, wann); jede Zeile beginnt mit - , getrennt durch \\n"}',
        "Nichts erfinden, kein Markdown.",
      ].join(" ")
    : [
        "Summarise a transcribed conversation in English.",
        "The transcript comes from automatic speech recognition and may contain errors; A:, B: … are speakers.",
        "Reply ONLY with JSON:",
        '{"kurz":"at most 3 very short lines separated by \\n, each at most 45 characters",',
        '"lang":"detailed summary: topic, main points, decisions, open questions, tasks (who, what, when); every line starts with - , separated by \\n"}',
        "Do not invent anything, no Markdown.",
      ].join(" ");
}

export function explainPrompt(locale: Locale, known: readonly string[]): string {
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
      return { short: (short.length ? short : long).slice(0, 3), long: long.length ? long : short };
    }
  }
  // Not JSON: use the text as it is, the first lines for the glasses.
  const plain = lines(content.replace(/<think>[\s\S]*?<\/think>/gi, ""));
  return plain.length ? { short: plain.slice(0, 3), long: plain } : null;
}

export function parseInsight(content: string): Insight | null {
  const json = extractJson(content);
  if (!json || json["keine"] === true) return null;
  const term = typeof json["begriff"] === "string" ? json["begriff"].trim() : "";
  const info = typeof json["info"] === "string" ? json["info"].trim() : "";
  if (!term || !info) return null;
  return { term: term.slice(0, 60), info: info.slice(0, 280) };
}

export function createCompanionLlm(config: CompanionLlmConfig): CompanionLlm {
  const doFetch = config.fetchImpl ?? fetch;
  const endpoint = chatCompletionsUrl(config.url);

  const chat = async (system: string, user: string, maxTokens: number, timeoutMs: number): Promise<Result<string>> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey ? { Authorization: "Bearer " + config.apiKey } : {}),
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: config.model,
          temperature: 0.2,
          stream: false,
          max_tokens: maxTokens,
          // Qwen-style reasoning off: answers must be quick and plain.
          chat_template_kwargs: { enable_thinking: false },
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
      });
      if (!response.ok) return { ok: false, error: "HTTP " + response.status };
      let value: unknown;
      try { value = JSON.parse(await response.text()); } catch { return { ok: false, error: "unreadable response" }; }
      const content = value && typeof value === "object" ? readChatContent(value as Record<string, unknown>) : null;
      return content === null ? { ok: false, error: "unreadable response" } : { ok: true, value: content };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    name: "openai",
    async summarize(log, locale) {
      if (log.length === 0) return { ok: false, error: "empty" };
      const reply = await chat(summaryPrompt(locale), transcriptForLlm(log), 900, config.summaryTimeoutMs ?? 55_000);
      if (!reply.ok) return reply;
      const summary = parseSummary(reply.value);
      return summary ? { ok: true, value: summary } : { ok: false, error: "empty response" };
    },
    async explain(recent, known, locale) {
      if (recent.length === 0) return { ok: true, value: null };
      const user = recent.map(speakerLine).join("\n");
      const reply = await chat(explainPrompt(locale, known), user, 160, config.explainTimeoutMs ?? 12_000);
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
