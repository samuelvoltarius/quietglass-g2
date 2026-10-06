/**
 * A script is a flat list of blocks. Sections exist only as markers inside that
 * list, so scrolling never has to cross a nested structure: the prompter always
 * works on one linear sequence of lines.
 */

export interface ScriptSection {
  /** Stable within one parse; used for jump targets and bookmarks. */
  readonly id: string;
  readonly title: string;
  /** Index into `Script.paragraphs` where this section starts. */
  readonly startParagraph: number;
}

export interface Script {
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly sections: readonly ScriptSection[];
}

export const EMPTY_SCRIPT: Script = { title: "", paragraphs: [], sections: [] };

export function isEmpty(script: Script): boolean {
  return script.paragraphs.length === 0;
}

/** Section containing a paragraph, or null when the text precedes any heading. */
export function sectionAtParagraph(script: Script, paragraph: number): ScriptSection | null {
  let found: ScriptSection | null = null;
  for (const section of script.sections) {
    if (section.startParagraph <= paragraph) found = section;
    else break;
  }
  return found;
}

/** The next section start strictly after `paragraph`, or null at the end. */
export function nextSectionStart(script: Script, paragraph: number): number | null {
  for (const section of script.sections) {
    if (section.startParagraph > paragraph) return section.startParagraph;
  }
  return null;
}

/**
 * Start of the previous section. Jumping back first returns to the start of the
 * current section, the way a track-back button behaves, and only moves to the
 * one before when already at a section start.
 */
export function previousSectionStart(script: Script, paragraph: number): number | null {
  const current = sectionAtParagraph(script, paragraph);
  if (!current) return null;
  if (current.startParagraph < paragraph) return current.startParagraph;

  let previous: ScriptSection | null = null;
  for (const section of script.sections) {
    if (section.startParagraph >= current.startParagraph) break;
    previous = section;
  }
  return previous ? previous.startParagraph : null;
}
