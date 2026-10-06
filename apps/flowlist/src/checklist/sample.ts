import type { Locale } from "../i18n";
import type { Checklist } from "./model";

/**
 * Shipped with the app and installed on first run, in the device language,
 * when storage is empty — so the glasses show something useful right away.
 *
 * They are working, everyday checklists, not placeholders. Together they use
 * every feature of the format — sections, extra info, an optional step, an
 * important step that asks before it is accepted, and a question that branches
 * — so the format is learnable by example. They can be removed like any other
 * checklist and added again from the phone.
 */

export const SAMPLE_IDS = ["sample-home", "sample-trip"] as const;

const LISTS: Record<Locale, readonly Checklist[]> = {
  de: [
    {
      id: "sample-home",
      title: "Haus verlassen",
      description: "Beispiel – du kannst sie ändern, exportieren oder entfernen.",
      steps: [
        { id: "windows", text: "Fenster zu", kind: "normal", section: "Wohnung" },
        {
          id: "stove",
          text: "Herd und Backofen aus",
          kind: "critical",
          section: "Wohnung",
          detail: "Kurz hinschauen – nicht nur dran denken.",
        },
        { id: "lights", text: "Licht aus", kind: "normal", section: "Wohnung" },
        {
          id: "rain",
          text: "Ist Regen angesagt?",
          kind: "choice",
          section: "Unterwegs",
          choices: [
            { label: "Ja", goto: "umbrella" },
            { label: "Nein", goto: "keys" },
          ],
        },
        { id: "umbrella", text: "Schirm einpacken", kind: "normal", section: "Unterwegs" },
        { id: "keys", text: "Schlüssel, Handy, Geldbörse", kind: "normal", section: "Unterwegs" },
        { id: "door", text: "Tür absperren", kind: "normal", section: "Unterwegs" },
      ],
    },
    {
      id: "sample-trip",
      title: "Reise packen",
      description: "Beispiel – du kannst sie ändern, exportieren oder entfernen.",
      steps: [
        {
          id: "passport",
          text: "Ausweis oder Reisepass",
          kind: "critical",
          section: "Dokumente",
          detail: "Ablaufdatum prüfen.",
        },
        { id: "tickets", text: "Tickets und Buchungen am Handy", kind: "normal", section: "Dokumente" },
        { id: "clothes", text: "Unterwäsche und Socken", kind: "normal", section: "Kleidung" },
        { id: "jacket", text: "Jacke für das Wetter dort", kind: "normal", section: "Kleidung" },
        { id: "phone", text: "Ladekabel fürs Handy", kind: "normal", section: "Technik" },
        { id: "glasses", text: "Ladehülle für die Brille", kind: "normal", section: "Technik" },
        {
          id: "adapter",
          text: "Reisestecker",
          kind: "optional",
          section: "Technik",
          detail: "Nur für Länder mit anderen Steckdosen.",
        },
        { id: "teeth", text: "Zahnbürste und Zahnpasta", kind: "normal", section: "Bad" },
        { id: "meds", text: "Medikamente", kind: "normal", section: "Bad" },
        { id: "sunscreen", text: "Sonnencreme", kind: "optional", section: "Bad" },
      ],
    },
  ],
  en: [
    {
      id: "sample-home",
      title: "Leaving the house",
      description: "Example — edit it, export it, or remove it.",
      steps: [
        { id: "windows", text: "Windows closed", kind: "normal", section: "Home" },
        {
          id: "stove",
          text: "Stove and oven off",
          kind: "critical",
          section: "Home",
          detail: "Take a look — don't just remember.",
        },
        { id: "lights", text: "Lights off", kind: "normal", section: "Home" },
        {
          id: "rain",
          text: "Is rain forecast?",
          kind: "choice",
          section: "Out",
          choices: [
            { label: "Yes", goto: "umbrella" },
            { label: "No", goto: "keys" },
          ],
        },
        { id: "umbrella", text: "Pack an umbrella", kind: "normal", section: "Out" },
        { id: "keys", text: "Keys, phone, wallet", kind: "normal", section: "Out" },
        { id: "door", text: "Lock the door", kind: "normal", section: "Out" },
      ],
    },
    {
      id: "sample-trip",
      title: "Packing for a trip",
      description: "Example — edit it, export it, or remove it.",
      steps: [
        {
          id: "passport",
          text: "ID card or passport",
          kind: "critical",
          section: "Documents",
          detail: "Check the expiry date.",
        },
        { id: "tickets", text: "Tickets and bookings on the phone", kind: "normal", section: "Documents" },
        { id: "clothes", text: "Underwear and socks", kind: "normal", section: "Clothes" },
        { id: "jacket", text: "A jacket for the weather there", kind: "normal", section: "Clothes" },
        { id: "phone", text: "Phone charger", kind: "normal", section: "Tech" },
        { id: "glasses", text: "Charging case for the glasses", kind: "normal", section: "Tech" },
        {
          id: "adapter",
          text: "Travel plug adapter",
          kind: "optional",
          section: "Tech",
          detail: "Only for countries with other sockets.",
        },
        { id: "teeth", text: "Toothbrush and toothpaste", kind: "normal", section: "Bathroom" },
        { id: "meds", text: "Medication", kind: "normal", section: "Bathroom" },
        { id: "sunscreen", text: "Sunscreen", kind: "optional", section: "Bathroom" },
      ],
    },
  ],
};

export function sampleChecklists(locale: Locale): readonly Checklist[] {
  return LISTS[locale];
}
