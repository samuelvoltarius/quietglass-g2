/**
 * Paperwork drafts from templates: when a talk says something is needed that
 * is a document (drone flight, location permit, consent of people on camera),
 * Shoot Day writes a draft as PDF into the project's files.
 *
 *   drohne           → consent of the land owner + internal flight checklist
 *   drehgenehmigung  → request and consent for filming at a location
 *   einverstaendnis  → consent to picture and sound recordings (staff, extras)
 *   praktikum        → internship agreement (INTERNAL: between production, intern and university – never to the customer)
 *   teambestaetigung → confirmation for the customer about the team on location (no personal data)
 *   mitarbeiterinfo  → information for the customer's staff about the shoot day
 *   hinweisschild    → A4 notice for guests/visitors on the shoot day (with short privacy notice)
 *
 * The templates are generic (Austria, German). Who writes them (letterhead,
 * logo) comes from a private brand file (SHOOT_BRAND_FILE), never from the
 * repository. Only the short "what is planned" paragraph is written by the
 * LOCAL model (SHOOT_LLM_URL); everything else is filled from Shoot Day's own
 * data, and what is unknown stays a line to fill in by hand – nothing is made up.
 *
 * The PDF is printed by a headless Chrome (SHOOT_PDF_CHROME or found on PATH).
 *
 * Dependency-free (Node 18+).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chatUrl } from "./shoot-day-pdf.mjs";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const BLANK = "<span class=\"blank\"></span>";
const SHORT = "<span class=\"blank short\"></span>";
/** The value, or a line to fill in by hand. */
const fill = (value) => (String(value ?? "").trim() ? esc(String(value).trim()) : BLANK);
const box = (label) => "<li><span class=\"box\"></span>" + esc(label) + "</li>";

/** "2026-10-20" / "20.10.2026" → "20.10.2026"; else the text as it is. */
export function germanDate(value) {
  const s = String(value ?? "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return iso ? `${iso[3]}.${iso[2]}.${iso[1]}` : s;
}

// ---------------------------------------------------------------------------
// Which template a "needed" point asks for.
// ---------------------------------------------------------------------------
const MATCHERS = [
  ["drohne", /drohne|drohnen|\buas\b|\buav\b|luftaufnahm|dronespace|austro.?control/i],
  ["einverstaendnis", /einverst|einwillig|model.?release|bildrecht|persönlichkeitsrecht|(zustimmung|freigabe|erlaubnis).{0,40}(mitarbeiter|personen|person|darsteller|gäste|kinder|aufnahme)|(mitarbeiter|personen|darsteller).{0,40}(zustimmung|freigabe|unterschrift)/i],
  ["praktikum", /praktik(um|ant)/i],
  ["teambestaetigung", /praktik(um|ant)|team.?bestätig|bestätigung.{0,25}(team|praktik|drehort)/i],
  ["mitarbeiterinfo", /mitarbeiter.?info|mitarbeitenden.?info|(info|information|briefing).{0,25}(mitarbeiter|mitarbeitende|personal|belegschaft)|(mitarbeiter|mitarbeitende|personal).{0,25}(informier|briefing)/i],
  ["hinweisschild", /hinweisschild|aushang|schild.{0,25}(gäste|gast|besucher|dreh)|(gäste|gast|besucher|kunden).{0,30}(hinweis|informier|schild)/i],
  ["drehgenehmigung", /drehgenehmig|drehbewillig|filmgenehmig|(genehmigung|bewilligung|erlaubnis|zustimmung|freigabe).{0,40}(dreh|gemeinde|location|drehort|grundstück|eigentümer|vermieter|stadt|park|straße)|(drehort|location|gemeinde).{0,40}(genehmig|bewillig|freigabe|erlaubnis)/i],
];

/** "Drohnengenehmigung" → "drohne", "Einverständnis der Mitarbeiter" → "einverstaendnis", anything else → null. */
export function matchTemplate(text) {
  return matchTemplates(text)[0] ?? null;
}

/** Every template a text asks for: "Praktikumsvereinbarung, Mitarbeiterinfo" → ["praktikum", "mitarbeiterinfo"]. */
export function matchTemplates(text) {
  const s = String(text ?? "");
  return MATCHERS.filter(([, pattern]) => pattern.test(s)).map(([id]) => id);
}

// ---------------------------------------------------------------------------
// The templates. Each one gives one or more documents: { name, title, body }.
// ---------------------------------------------------------------------------
function who(brand) {
  return fill([brand?.name, brand?.owner ? "Inh. " + brand.owner : ""].filter(Boolean).join(", "));
}
function client(customer) {
  return fill([customer?.company, customer?.name && customer?.name !== customer?.company ? customer.name : ""].filter(Boolean).join(", "));
}
/** Signature row; with a chosen document date (`c.docDate`) it is printed above "Ort, Datum". */
const signatures = (c, left, right) => `
  <div class="signatures">
    <div><div class="line">${c.docDate ? "<span>" + esc(germanDate(c.docDate)) + "</span>" : ""}</div>Ort, Datum</div>
    <div><div class="line"></div>${esc(left)}</div>
    ${right ? `<div><div class="line"></div>${esc(right)}</div>` : "<div></div>"}
  </div>`;

const TEMPLATES = {
  drohne: {
    label: "Drohnenflug",
    docs: (c) => [
      {
        name: "Zustimmung Grundeigentümer Drohnenflug",
        title: "Zustimmung zu Start, Landung und Überflug mit einer Drohne",
        body: `
  <p class="lead">Zustimmung des Grundeigentümers bzw. der verfügungsberechtigten Person für Film- und Fotoaufnahmen mit einem unbemannten Luftfahrzeug (Drohne).</p>
  <table class="facts">
    <tr><th>Grundeigentümer / verfügungsberechtigt</th><td>${fill(c.facts.eigentuemer)}</td></tr>
    <tr><th>Anschrift</th><td>${BLANK}</td></tr>
    <tr><th>Grundstück / Ort</th><td>${fill(c.place)}</td></tr>
    <tr><th>Zeitraum</th><td>${BLANK}</td></tr>
    <tr><th>Betreiber</th><td>${who(c.brand)}</td></tr>
    <tr><th>UAS-Betreiber-Nr.</th><td>${fill(c.brand?.uasOperator)}</td></tr>
    <tr><th>Fernpilot/in</th><td>${fill(c.brand?.pilot)}</td></tr>
    <tr><th>Auftraggeber</th><td>${client(c.customer)}</td></tr>
  </table>
  <h2>Vorhaben</h2>
  <p>${fill(c.purpose)}</p>
  <h2>Zustimmung</h2>
  <ol>
    <li>Ich gestatte dem Betreiber, im genannten Zeitraum auf dem genannten Grundstück mit einer Drohne zu starten, zu landen und das Grundstück zu überfliegen.</li>
    <li>Der Betreiber hält die geltenden luftfahrtrechtlichen Vorschriften ein und verfügt über die vorgeschriebene Haftpflichtversicherung.</li>
    <li>Die Aufnahmen werden nur für das oben beschriebene Vorhaben verwendet. Erkennbare Personen werden nur mit deren Einverständnis gezeigt.</li>
    <li>Schäden, die beim Flugbetrieb entstehen, werden vom Betreiber bzw. dessen Versicherung ersetzt.</li>
    <li>Die Zustimmung kann vor dem Flug jederzeit widerrufen werden.</li>
  </ol>
  <p>Auflagen / Einschränkungen (z. B. Zeiten, Bereiche, die nicht überflogen werden dürfen):</p>
  <div class="field"></div>
  ${signatures(c, "Grundeigentümer / verfügungsberechtigte Person", "Betreiber")}`,
      },
      {
        name: "INTERN Checkliste Drohnenflug",
        title: "Checkliste Drohnenflug",
        body: `
  <p class="intern-band">INTERN – nur für das Team, nie an den Kunden oder Dritte weitergeben</p>
  <p class="lead">Interne Checkliste vor dem Flug – nicht zur Weitergabe. Regeln ändern sich: vor jedem Einsatz die aktuellen Vorgaben auf dronespace.at (Austro Control) prüfen.</p>
  <table class="facts">
    <tr><th>Auftraggeber</th><td>${client(c.customer)}</td></tr>
    <tr><th>Ort</th><td>${fill(c.place)}</td></tr>
    <tr><th>Datum</th><td>${BLANK}</td></tr>
    <tr><th>Drohne / Klasse</th><td>${BLANK}</td></tr>
  </table>
  <h2>Vorher</h2>
  <ul class="check">
    ${box("Betreiber registriert, Betreiber-Nr. gut sichtbar an der Drohne")}
    ${box("Kompetenznachweis der Fernpilotin / des Fernpiloten passend zur Kategorie (A1/A3 bzw. A2)")}
    ${box("Betriebskategorie geklärt: offen (A1/A2/A3) oder speziell – dann Betriebsgenehmigung nötig")}
    ${box("UAS-Geozonen auf der Dronespace-Karte geprüft (Kontrollzonen, Naturschutz, Siedlung, Infrastruktur)")}
    ${box("Falls Geozone: Freigabe/Genehmigung eingeholt und ausgedruckt dabei")}
    ${box("Zustimmung Grundeigentümer für Start, Landung und Überflug unterschrieben")}
    ${box("Einverständnis erkennbarer Personen im Bild (eigene Vorlage)")}
    ${box("Haftpflichtversicherung gültig, Nachweis dabei")}
    ${box("Wetter und Wind geprüft, Akkus geladen, Firmware/Karten aktuell")}
  </ul>
  <h2>Vor Ort</h2>
  <ul class="check">
    ${box("Höchstens 120 m über Grund, Sichtverbindung zur Drohne")}
    ${box("Abstand zu unbeteiligten Personen, keine Menschenansammlungen überfliegen")}
    ${box("Start- und Landeplatz abgesichert, Beobachter eingeteilt")}
    ${box("Privatsphäre: keine Aufnahmen in fremde Gärten, Fenster oder Grundstücke ohne Zustimmung")}
  </ul>
  <h2>Notizen</h2>
  <div class="field tall"></div>`,
      },
    ],
  },

  drehgenehmigung: {
    label: "Drehgenehmigung",
    docs: (c) => [{
      name: "Drehgenehmigung",
      title: "Anfrage und Zustimmung zu Film- und Fotoaufnahmen",
      body: `
  <p class="lead">Wir bitten um die Erlaubnis, am unten genannten Ort Film- und Fotoaufnahmen zu machen.</p>
  <table class="facts">
    <tr><th>An (Eigentümer / Gemeinde / Verwaltung)</th><td>${BLANK}</td></tr>
    <tr><th>Drehort</th><td>${fill(c.location || c.place)}</td></tr>
    <tr><th>Termin</th><td>${BLANK}</td></tr>
    <tr><th>Uhrzeit (von – bis, inkl. Auf- und Abbau)</th><td>${BLANK}</td></tr>
    <tr><th>Produktion</th><td>${who(c.brand)}</td></tr>
    <tr><th>Auftraggeber</th><td>${client(c.customer)}</td></tr>
    <tr><th>Ansprechperson vor Ort</th><td>${fill(c.contact || c.facts.ansprechperson)}</td></tr>
  </table>
  <h2>Vorhaben</h2>
  <p>${fill(c.purpose)}</p>
  <h2>Umfang</h2>
  <table class="facts">
    <tr><th>Team</th><td>${c.facts.team ? fill(c.facts.team) : "ca. " + BLANK + " Personen"}</td></tr>
    <tr><th>Technik</th><td>Kamera, Ton, Licht ${BLANK}</td></tr>
    <tr><th>Fahrzeuge / Parken</th><td>${BLANK}</td></tr>
    <tr><th>Strom</th><td>eigene Akkus / Anschluss vor Ort ${BLANK}</td></tr>
    <tr><th>Absperrungen</th><td>keine / ${BLANK}</td></tr>
  </table>
  <h2>Zusagen der Produktion</h2>
  <ol>
    <li>Der Betrieb vor Ort wird so wenig wie möglich gestört; Anweisungen der Ansprechperson werden befolgt.</li>
    <li>Der Drehort wird so hinterlassen, wie er vorgefunden wurde.</li>
    <li>Eine Betriebshaftpflichtversicherung besteht; Schäden werden ersetzt.</li>
    <li>Personen im Bild werden nur mit ihrem Einverständnis gezeigt.</li>
  </ol>
  <h2>Zustimmung</h2>
  <p>Die Aufnahmen werden wie oben beschrieben gestattet. Auflagen / Kosten:</p>
  <div class="field"></div>
  ${signatures(c, "Eigentümer / Gemeinde / Verwaltung", "Produktion")}`,
    }],
  },

  einverstaendnis: {
    label: "Einverständnis Bild- und Tonaufnahmen",
    docs: (c) => [{
      name: "Einverständnis Bild- und Tonaufnahmen",
      title: "Einverständniserklärung zu Bild- und Tonaufnahmen",
      body: `
  <table class="facts">
    <tr><th>Name</th><td>${BLANK}</td></tr>
    <tr><th>Anschrift / E-Mail</th><td>${BLANK}</td></tr>
    <tr><th>Aufnahmetag</th><td>${BLANK}</td></tr>
    <tr><th>Ort</th><td>${fill(c.location || c.place)}</td></tr>
    <tr><th>Produktion</th><td>${who(c.brand)}</td></tr>
    <tr><th>Auftraggeber</th><td>${client(c.customer)}</td></tr>
  </table>
  <h2>Worum es geht</h2>
  <p>${fill(c.purpose)}</p>
  <h2>Einverständnis</h2>
  <p>Ich bin damit einverstanden, dass von mir Film-, Foto- und Tonaufnahmen gemacht und – auch bearbeitet (Schnitt, Farbe, Ausschnitt) – für folgende Zwecke veröffentlicht werden:</p>
  <ul class="check">
    ${box("Website des Auftraggebers")}
    ${box("Social Media (z. B. Instagram, Facebook, TikTok, YouTube, LinkedIn)")}
    ${box("Werbung online und in Druckwerken")}
    ${box("Fernsehen / Kino / Veranstaltungen")}
    ${box("Referenz der Produktion (Website, Showreel)")}
    ${box("nur intern")}
  </ul>
  <p>Dauer: ${SHORT} (ohne Angabe: unbefristet) · Vergütung: unentgeltlich / ${SHORT}</p>
  <h2>Freiwilligkeit und Widerruf</h2>
  <p>Die Einwilligung ist freiwillig. Wer nicht einwilligt, hat dadurch keine Nachteile – auch nicht im Arbeitsverhältnis. Die Einwilligung kann jederzeit ohne Angabe von Gründen schriftlich widerrufen werden (Art. 7 Abs. 3 DSGVO). Der Widerruf wirkt für die Zukunft: Die Aufnahmen werden ab dann nicht mehr neu veröffentlicht und, soweit möglich, aus Online-Angeboten entfernt; bereits gedruckte oder gesendete Werke bleiben davon unberührt.</p>
  <h2>Datenschutz</h2>
  <p>Verantwortlich für die Aufnahmen: ${who(c.brand)}${c.brand?.email ? ", " + esc(c.brand.email) : ""}; für die Veröffentlichung zusätzlich der Auftraggeber. Zweck sind die oben angekreuzten Veröffentlichungen. Sie haben das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit und Beschwerde bei der Österreichischen Datenschutzbehörde (dsb.gv.at).</p>
      ${signatures(c, "Unterschrift der aufgenommenen Person", "bei Minderjährigen: Erziehungsberechtigte")}`,
    }],
  },

  praktikum: {
    label: "Praktikumsvereinbarung (INTERN)",
    internal: true,
    docs: (c) => [{
      name: "Praktikumsvereinbarung",
      title: "Praktikumsvereinbarung",
      body: `
  <table class="facts">
    <tr><th>Praktikumsstelle</th><td>${who(c.brand)}</td></tr>
    <tr><th>Praktikant/in</th><td>${fill(c.facts.praktikant)}</td></tr>
    <tr><th>Geburtsdatum / Anschrift</th><td>${BLANK}</td></tr>
    <tr><th>Hochschule (Fachhochschule)</th><td>${fill(c.facts.schule)}</td></tr>
    <tr><th>Studiengang / Semester / Matrikelnr.</th><td>${BLANK}</td></tr>
    <tr><th>Zeitraum</th><td>${fill(c.facts.zeitraum)}</td></tr>
    <tr><th>Betreuung Praktikumsstelle / Hochschule</th><td>${fill(c.facts.betreuer || c.brand?.owner)} / ${SHORT}</td></tr>
  </table>
  <h2>Art des Praktikums</h2>
  <p>Pflichtpraktikum laut Studienplan der oben genannten Hochschule. Ergänzend gelten deren Praktikumsrichtlinien; gibt die Hochschule ein eigenes Formular vor, hat dieses Vorrang.</p>
  <ul class="check">
    ${box("Ausbildungsverhältnis (Ausbildungszweck, keine Arbeitspflicht)")}
    ${box("Arbeitsverhältnis (Anmeldung bei der ÖGK, Entgelt laut Kollektivvertrag)")}
  </ul>
  <h2>Inhalt und Ziel</h2>
  <p>${fill(c.purpose)}</p>
  <h2>Vereinbarung</h2>
  <ol>
    <li>Das Praktikum dient der Ausbildung: Kennenlernen von Vorbereitung, Dreh und Nachbearbeitung von Film- und Fotoproduktionen. Die Betreuungsperson leitet an und steht für Fragen zur Verfügung.</li>
    <li>Anwesenheit nach Absprache, voraussichtlich ${SHORT} Stunden pro Woche; Drehtage können früh beginnen oder länger dauern.</li>
    <li>Vergütung: ${SHORT} (ohne Angabe: unentgeltlich) · Fahrtkosten: ${SHORT}</li>
    <li>Der Unfallversicherungsschutz wird vor Beginn mit der Hochschule geklärt (bzw. über die Anmeldung bei der ÖGK).</li>
    <li>Über Kunden, Projekte und nicht veröffentlichte Aufnahmen ist Verschwiegenheit zu wahren, auch nach dem Praktikum; personenbezogene Daten nur für das Projekt. Technik wird sorgfältig behandelt, Schäden werden sofort gemeldet.</li>
    <li>Die Rechte an Aufnahmen und Ergebnissen aus dem Praktikum liegen bei der Praktikumsstelle bzw. beim Auftraggeber. Die Praktikantin / der Praktikant darf veröffentlichte Arbeiten mit Nennung als Referenz zeigen.</li>
    <li>Beide Seiten können das Praktikum jederzeit beenden; die Hochschule wird informiert. Am Ende gibt es eine Praktikumsbestätigung für die Hochschule.</li>
  </ol>
  <div class="signatures four">
    <div><div class="line">${c.docDate ? "<span>" + esc(germanDate(c.docDate)) + "</span>" : ""}</div>Ort, Datum</div>
    <div><div class="line"></div>Praktikumsstelle</div>
    <div><div class="line"></div>Praktikant/in</div>
    <div><div class="line"></div>Hochschule</div>
  </div>`,
    }],
  },

  teambestaetigung: {
    label: "Bestätigung Team am Drehort (für den Kunden)",
    docs: (c) => [{
      name: "Bestätigung Team am Drehort",
      title: "Bestätigung: Team am Drehort",
      body: `
  <table class="facts">
    <tr><th>Für</th><td>${client(c.customer)}</td></tr>
    <tr><th>Drehtermin</th><td>${BLANK}</td></tr>
    <tr><th>Drehort</th><td>${fill(c.location || c.place)}</td></tr>
    <tr><th>Verantwortliche Produktion</th><td>${who(c.brand)}</td></tr>
    <tr><th>Ansprechperson am Drehtag</th><td>${fill(c.facts.betreuer || c.brand?.owner)}${c.brand?.phone ? ", " + esc(c.brand.phone) : ""}</td></tr>
  </table>
  <h2>Team vor Ort</h2>
  <table class="facts">
    <tr><th>Name</th><td>Funktion</td></tr>
    <tr><th>${BLANK}</th><td>${BLANK}</td></tr>
    <tr><th>${BLANK}</th><td>${BLANK}</td></tr>
    <tr><th>${BLANK}</th><td>${BLANK}</td></tr>
  </table>
  <h2>Wir bestätigen</h2>
  <ol>
    <li>Das Team arbeitet im Auftrag und unter der Verantwortung der oben genannten Produktion. Praktikantinnen und Praktikanten absolvieren ein Pflichtpraktikum ${c.facts.schule ? "der " + esc(c.facts.schule) : "ihrer Hochschule"} und arbeiten unter Anleitung.</li>
    <li>Alle Teammitglieder sind zur Verschwiegenheit verpflichtet – über Betriebsabläufe, Rezepturen, Gäste und alles, was sie am Drehort erfahren.</li>
    <li>Für Schäden am Drehort besteht eine Betriebshaftpflichtversicherung der Produktion; der Unfallversicherungsschutz der Praktikantinnen und Praktikanten ist geklärt.</li>
    <li>Personen werden nur mit ihrem Einverständnis erkennbar gezeigt; Anweisungen der Ansprechperson des Betriebs werden befolgt.</li>
  </ol>
  <p class="lead">Die Praktikumsverträge selbst sind interne Vereinbarungen zwischen Produktion, Praktikant/in und Hochschule und werden aus Datenschutzgründen nicht weitergegeben.</p>
  ${signatures(c, "Verantwortliche Produktion", "")}`,
    }],
  },

  mitarbeiterinfo: {
    label: "Mitarbeiterinfo zum Drehtag",
    docs: (c) => [{
      name: "Mitarbeiterinfo Drehtag",
      title: "Information für Ihr Team: Filmaufnahmen",
      body: `
  <table class="facts">
    <tr><th>Wann</th><td>${BLANK}</td></tr>
    <tr><th>Wo</th><td>${fill(c.location || c.place)}</td></tr>
    <tr><th>Für</th><td>${client(c.customer)}</td></tr>
    <tr><th>Produktion</th><td>${who(c.brand)}</td></tr>
    <tr><th>Ansprechperson</th><td>${fill(c.contact || c.facts.ansprechperson)}</td></tr>
  </table>
  <h2>Worum es geht</h2>
  <p>${fill(c.purpose)}</p>
  <h2>Was das für Sie bedeutet</h2>
  <ul>
    <li>Sie arbeiten wie gewohnt. Manchmal bitten wir, einen Handgriff oder Weg zu wiederholen.</li>
    <li>Ein kleines Team mit Kamera, Ton und Licht ist vor Ort; Kabel und Stative stehen kurzzeitig im Weg – bitte Vorsicht.</li>
    <li>Wer erkennbar im Bild sein möchte, unterschreibt vorher die Einverständniserklärung. Wer nicht gefilmt werden möchte, sagt es uns einfach – das ist kein Problem und hat keinerlei Nachteile.</li>
    <li>Bitte private Dinge (Handys, Notizen, Dienstpläne) aus dem Drehbereich nehmen.</li>
    <li>Fragen jederzeit an die Ansprechperson oder direkt an uns.</li>
  </ul>
  <h2>Ablauf</h2>
  <div class="field tall"></div>
  <p class="lead">Danke für Ihre Unterstützung!</p>`,
    }],
  },

  hinweisschild: {
    label: "Hinweisschild für Gäste",
    docs: (c) => [{
      name: "Hinweisschild Gäste Drehtag",
      title: "Heute Film- und Fotoaufnahmen",
      className: "sign",
      body: `
  <p class="big">${BLANK}${c.location || c.place ? " · " + esc(c.location || c.place) : ""}</p>
  <p class="big">Wir drehen heute für ${client(c.customer)}.</p>
  <p class="big">Sie möchten nicht im Bild sein? Sprechen Sie bitte unser Team an oder nehmen Sie außerhalb des markierten Drehbereichs Platz – wir richten uns gerne nach Ihnen.</p>
  <p class="big">Erkennbare Aufnahmen von Gästen veröffentlichen wir nur mit Ihrer Zustimmung.</p>
  <h2>Datenschutz-Kurzinfo</h2>
  <p>Verantwortlich: ${who(c.brand)}${c.brand?.email ? ", " + esc(c.brand.email) : ""}, gemeinsam mit ${client(c.customer)}. Zweck: Film- und Fotoaufnahmen für Werbung und Information. Rechtsgrundlage: berechtigtes Interesse (Art. 6 Abs. 1 lit. f DSGVO), für erkennbare Veröffentlichungen Ihre Einwilligung (Art. 6 Abs. 1 lit. a DSGVO). Sie haben das Recht auf Auskunft, Löschung, Widerspruch und Beschwerde bei der Datenschutzbehörde (dsb.gv.at).</p>`,
    }],
  },
};

export const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));
/** Templates that are internal paperwork: never sent to the customer. */
export const isInternalTemplate = (id) => Boolean(TEMPLATES[id]?.internal);
const INTERN_BAND = '\n  <p class="intern-band">INTERN – nur für Produktion, Praktikant/in und Hochschule, nie an den Kunden weitergeben</p>';
export const templateLabel = (id) => TEMPLATES[id]?.label ?? "";

/** The facts a template is filled with, from Shoot Day's own data only. */
/** "… im Rahmen des Projekts „Vorgespraech Ideen“ …" → "… im Rahmen des Projekts …": the working name stays inside. */
export function withoutProjectName(text, name) {
  const n = String(name ?? "").trim();
  if (!text || n.length < 3) return text ?? "";
  const pattern = new RegExp("\\s*[„\"“»']?" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[“\"«']?", "gi");
  return String(text).replace(pattern, "").replace(/\s+([,.;:])/g, "$1").replace(/\s{2,}/g, " ").trim();
}

export function docContext({ brand = null, customer = null, project = null, purpose = "", facts = {}, docDate = "" } = {}) {
  const dispo = project?.dispo ?? {};
  return {
    brand, customer, project, purpose: withoutProjectName(purpose, project?.name), facts: facts ?? {}, docDate: /^\d{4}-\d{2}-\d{2}$/.test(String(docDate)) ? docDate : "",
    date: project?.date || dispo.date || facts?.termin || "",
    place: project?.place || dispo.location || facts?.ort || "",
    location: dispo.location || project?.place || facts?.ort || "",
    call: dispo.call || "",
    contact: dispo.contact || "",
  };
}

const STYLE = `
  @page { size: A4; margin: 13mm 17mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, "Liberation Sans", "DejaVu Sans", sans-serif; font-size: 10pt; line-height: 1.4; color: #1d1d1b; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1.5pt solid #2f6b1f; padding-bottom: 4mm; margin-bottom: 5mm; }
  header img { height: 18mm; }
  header .sender { text-align: right; font-size: 8.5pt; color: #555; line-height: 1.35; }
  header .sender strong { color: #1d1d1b; font-size: 9.5pt; }
  h1 { font-size: 15pt; margin: 0 0 3mm; }
  h2 { font-size: 10.5pt; margin: 4mm 0 1.5mm; color: #2f6b1f; }
  p { margin: 0 0 2mm; }
  .lead { color: #444; }
  table.facts { width: 100%; border-collapse: collapse; margin: 2mm 0 1mm; }
  table.facts th { text-align: left; font-weight: normal; color: #555; width: 42%; padding: 1.2mm 3mm 1.2mm 0; vertical-align: bottom; }
  table.facts td { padding: 1.2mm 0; border-bottom: 0.5pt solid #bbb; vertical-align: bottom; }
  .blank { display: inline-block; min-width: 45mm; border-bottom: 0.5pt solid #888; height: 1em; }
  .blank.short { min-width: 28mm; }
  table.facts td .blank { border: 0; }
  ol, ul { margin: 0 0 2mm; padding-left: 6mm; }
  li { margin-bottom: 0.8mm; }
  ul.check { list-style: none; padding-left: 0; }
  .box { display: inline-block; width: 3.4mm; height: 3.4mm; border: 0.7pt solid #333; margin-right: 2.5mm; vertical-align: -0.4mm; }
  .field { border: 0.5pt solid #999; height: 13mm; margin: 1mm 0 2mm; }
  .field.tall { height: 35mm; }
  .signatures { display: grid; grid-template-columns: 0.7fr 1fr 1fr; column-gap: 8mm; margin-top: 8mm; font-size: 8.5pt; color: #555; page-break-inside: avoid; }
  .signatures.four { grid-template-columns: 0.8fr 1fr 1fr 1fr; column-gap: 6mm; }
  .signatures .line span { position: relative; top: 4mm; padding-left: 14mm; color: #1d1d1b; font-size: 10pt; }
  header .stand { margin-top: 1.5mm; color: #777; }
  .signatures .line { border-bottom: 0.6pt solid #333; height: 8mm; margin-bottom: 1mm; }
  body { padding-bottom: 8mm; }
  footer { position: fixed; left: 0; right: 0; bottom: 0; padding-top: 1.5mm; border-top: 0.5pt solid #ccc; font-size: 7.5pt; color: #777; text-align: center; background: #fff; }
  h1, h2 { page-break-after: avoid; }
  section + section { page-break-before: always; }
  .intern-band { margin: 0 0 4mm; padding: 2.5mm 4mm; border: 1.2pt solid #b5361b; color: #b5361b; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; text-align: center; }
  body.sign h1 { font-size: 30pt; margin: 8mm 0 8mm; color: #2f6b1f; }
  body.sign .big { font-size: 16pt; line-height: 1.35; margin-bottom: 6mm; }
  body.sign .big .blank { min-width: 60mm; }
`;

/** One finished A4 page (HTML) for one document of a template. */
export function docHtml(doc, { brand = null, logoDataUri = "", stand = "" } = {}) {
  const sender = brand ? [
    brand.name ? "<strong>" + esc(brand.name) + "</strong>" : "",
    esc(brand.address ?? ""),
    [brand.phone, brand.email].filter(Boolean).map(esc).join(" · "),
    esc(brand.web ?? ""),
  ].filter(Boolean).join("<br>") : "";
  const standLine = stand ? `<div class="stand">Stand: ${esc(germanDate(stand))}</div>` : "";
  const foot = brand ? [brand.name, brand.address, brand.uid ? "UID " + brand.uid : ""].filter(Boolean).map(esc).join(" · ") : "";
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${esc(doc.title)}</title><style>${STYLE}</style></head><body${doc.className ? ` class="${esc(doc.className)}"` : ""}>
<header>${logoDataUri ? `<img src="${esc(logoDataUri)}" alt="">` : "<span></span>"}<div class="sender">${sender}${standLine}</div></header>
<h1>${esc(doc.title)}</h1>
${doc.body}
${foot ? `<footer>${foot}</footer>` : ""}
</body></html>`;
}

/** The documents a template gives for this project, ready to print. */
export function draftDocuments(templateId, context, options = {}) {
  const template = TEMPLATES[templateId];
  if (!template) return [];
  // "Stand": the day the draft is written (or the chosen document date)
  // no automatic date on paper (it confused readers); only a date chosen by hand is printed – next to "Ort, Datum"
  const stand = options.stand ?? "";
  return template.docs({ facts: {}, ...context }).map((doc) => {
    if (!template.internal || /^INTERN/.test(doc.name)) return { name: doc.name, title: doc.title, html: docHtml(doc, { ...options, stand }) };
    const marked = { ...doc, name: "INTERN " + doc.name, body: INTERN_BAND + doc.body };
    return { name: marked.name, title: doc.title, html: docHtml(marked, { ...options, stand }) };
  });
}

// ---------------------------------------------------------------------------
// The one paragraph the local model writes: what is planned.
// ---------------------------------------------------------------------------
export function purposeMessages({ templateId, customer, project, point, summary }) {
  const facts = [
    "Unterlage: " + templateLabel(templateId),
    customer?.company || customer?.name ? "Auftraggeber: " + (customer.company || customer.name) : "",
    project?.place ? "Ort: " + project.place : "",
    point ? "Aus dem Gespräch benötigt: " + point : "",
    summary ? "Gesprächsnotizen:\n" + String(summary).slice(0, 2000) : "",
  ].filter(Boolean).join("\n");
  return [
    { role: "system", content: "Du schreibst für eine Filmproduktion den Absatz „Vorhaben“ in einer Unterlage (Genehmigung bzw. Einverständniserklärung). "
      + "2 bis 4 sachliche Sätze in Sie-Form auf Deutsch: was gedreht wird, wofür und wo. KEINE Daten oder Uhrzeiten und NIE den internen Projektnamen nennen. Nur Fakten aus den Angaben, nichts erfinden; "
      + "fehlt etwas, lass es weg. Keine Überschrift, keine Aufzählung, keine Anführungszeichen, keine Platzhalter. Antworte nur mit dem Absatz." },
    { role: "user", content: facts },
  ];
}

/** Plain, short, one paragraph – or "" when the reply does not look like one. */
export function cleanPurpose(content) {
  const text = String(content ?? "").replace(/```[\s\S]*?```/g, "").replace(/^\s*(vorhaben|absatz)\s*:\s*/i, "").replace(/\s+/g, " ").trim().replace(/^["„“]|["“”]$/g, "");
  if (text.length < 20 || text.length > 900 || /[{}[\]<>]|_{3,}|\.\.\.$/.test(text)) return "";
  return text;
}

/** Never throws; "" when there is no model or no usable answer (the document then gets a line to fill in). */
export async function writePurpose(input, { url, model = "", token = "", timeoutMs = 60_000, fetchImpl = fetch } = {}) {
  const endpoint = chatUrl(url);
  if (!endpoint) return "";
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: JSON.stringify({ ...(model ? { model } : {}), messages: purposeMessages(input), temperature: 0.2, max_tokens: 400, stream: false, chat_template_kwargs: { enable_thinking: false } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return "";
    const reply = await response.json();
    return cleanPurpose(reply?.choices?.[0]?.message?.content ?? "");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Letterhead and printing.
// ---------------------------------------------------------------------------
const BRAND_KEYS = ["name", "owner", "address", "phone", "email", "web", "uid", "uasOperator", "pilot"];

/** The private brand file: {name, owner, address, phone, email, web, uid, uasOperator?, pilot?, logo?: "file.png"}. */
export async function loadBrand(file) {
  if (!file) return { brand: null, logoDataUri: "" };
  const raw = JSON.parse(await readFile(file, "utf8"));
  const brand = {};
  for (const key of BRAND_KEYS) if (typeof raw?.[key] === "string" && raw[key].trim()) brand[key] = raw[key].trim().slice(0, 200);
  let logoDataUri = "";
  if (typeof raw?.logo === "string" && /^[\w.-]+\.png$/i.test(raw.logo)) {
    const png = await readFile(join(file, "..", raw.logo));
    logoDataUri = "data:image/png;base64," + png.toString("base64");
  }
  return { brand, logoDataUri };
}

/** Chrome from SHOOT_PDF_CHROME, else the first one on PATH; "" when there is none. */
export function findChrome(explicit = "", path = process.env["PATH"] ?? "") {
  if (explicit) return existsSync(explicit) ? explicit : "";
  for (const dir of path.split(delimiter)) {
    for (const name of ["google-chrome", "chromium", "chromium-browser", "google-chrome-stable"]) {
      if (dir && existsSync(join(dir, name))) return join(dir, name);
    }
  }
  return "";
}

/** HTML → PDF bytes with a headless Chrome. Throws on failure. */
export async function printPdf(html, { chrome, timeoutMs = 60_000 } = {}) {
  if (!chrome) throw new Error("no chrome for PDF printing");
  const dir = await mkdtemp(join(tmpdir(), "shootday-doc-"));
  try {
    const input = join(dir, "doc.html");
    const output = join(dir, "doc.pdf");
    await writeFile(input, html, "utf8");
    await new Promise((resolve, reject) => {
      const child = spawn(chrome, [
        "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
        "--user-data-dir=" + join(dir, "profile"), "--no-pdf-header-footer", "--print-to-pdf-no-header",
        "--print-to-pdf=" + output, pathToFileURL(input).href,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (chunk) => { if (err.length < 2000) err += chunk; });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("chrome timed out")); }, timeoutMs);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("chrome exited " + code + ": " + err.split("\n").filter(Boolean).slice(-1)[0])); });
    });
    const pdf = await readFile(output);
    if (pdf.length < 100 || pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("chrome wrote no PDF");
    return pdf;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
