import type { Script, ScriptSection } from "./model";

/**
 * Accepts Markdown or plain text. Only the subset a spoken script needs is
 * interpreted — headings and paragraph breaks. Inline emphasis is stripped
 * rather than rendered, because the glasses expose no font styling.
 */

export interface ParseOptions {
  /** Treat `# ` / `## ` lines as section headings. Default true. */
  readonly markdown?: boolean;
  /** Fallback title when the script has no `# ` heading. */
  readonly fallbackTitle?: string;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+/;
const ORDERED = /^\s*\d+[.)]\s+/;

export function parseScript(raw: string, options: ParseOptions = {}): Script {
  const markdown = options.markdown ?? true;
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");

  let title = "";
  const paragraphs: string[] = [];
  const sections: ScriptSection[] = [];
  let buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    const text = buffer.join(" ").replace(/\s+/g, " ").trim();
    if (text) paragraphs.push(text);
    buffer = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "") {
      flush();
      continue;
    }

    const heading = markdown ? HEADING.exec(trimmed) : null;
    if (heading) {
      flush();
      const level = heading[1]?.length ?? 1;
      const text = cleanInline(heading[2] ?? "");
      // The first level-1 heading titles the script rather than opening a section.
      if (level === 1 && !title && sections.length === 0) {
        title = text;
        continue;
      }
      sections.push({
        id: `s${sections.length + 1}`,
        title: text,
        startParagraph: paragraphs.length,
      });
      continue;
    }

    // List items read as their own beat, so they are not merged into a paragraph.
    if (markdown && (BULLET.test(line) || ORDERED.test(line))) {
      flush();
      paragraphs.push(cleanInline(trimmed.replace(BULLET, "").replace(ORDERED, "")));
      continue;
    }

    buffer.push(markdown ? cleanInline(trimmed) : trimmed);
  }
  flush();

  return {
    title: title || options.fallbackTitle || "",
    paragraphs,
    sections,
  };
}

/** Removes Markdown emphasis the display cannot express; keeps the words. */
function cleanInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/(\*\*\*|___)(.*?)\1/g, "$2")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .trim();
}
