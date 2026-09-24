import type { Checklist } from "./model";

/**
 * Shipped with the app and installed on first run, when storage is empty.
 *
 * It is a working checklist, not a placeholder: it demonstrates every feature
 * of the format — sections, a detail line, an optional step, a critical step
 * that asks before it is accepted, and a branch — so the format is learnable
 * by reading one example. It can be removed like any other checklist.
 */
export const SAMPLE_CHECKLIST: Checklist = {
  id: "sample",
  title: "Camera pre-flight",
  description: "Example checklist. Edit it, export it, or remove it.",
  steps: [
    { id: "battery", text: "Battery in, spare in the bag", kind: "normal", section: "Camera" },
    {
      id: "card",
      text: "Card formatted",
      kind: "critical",
      section: "Camera",
      detail: "Formatting erases everything. Offload first.",
    },
    { id: "settings", text: "Frame rate and shutter set", kind: "normal", section: "Camera" },
    {
      id: "where",
      text: "Shooting indoors?",
      kind: "choice",
      section: "Location",
      choices: [
        { label: "Indoors", goto: "lights" },
        { label: "Outdoors", goto: "nd" },
      ],
    },
    { id: "lights", text: "Lights up, white balance set", kind: "normal", section: "Location" },
    { id: "nd", text: "ND filter fitted", kind: "optional", section: "Location" },
    { id: "audio", text: "Audio levels checked", kind: "normal", section: "Sound" },
    { id: "rec", text: "Press record", kind: "normal", section: "Sound" },
  ],
};
