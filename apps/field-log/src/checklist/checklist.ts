import type { Locale } from "../i18n";
import type { Inspection } from "../log/entries";

/**
 * A room-by-room handover checklist (flat handover, car return, site check).
 *
 * Edited on the phone as plain text, one line per item:
 *
 *     # Kitchen            a line starting with "#" opens a room
 *     Oven clean           an item
 *     ! Gas turned off     "!" at the start: critical (OK needs a second tap)
 *     Window frame [photo] "[photo]", "[foto]" or "📷" anywhere: a photo is required
 *
 * Empty lines are ignored, list bullets (`-`, `*`, `- [ ]`) are dropped, items
 * before the first room go into a room called "General". The checklist belongs
 * to one inspection and is stored with it; the state of each item (OK or
 * defect) is kept apart from the text, keyed by a stable id made of the room
 * and the item text, so editing the list keeps what was already checked.
 */

export interface CheckItem {
  /** Stable key: room and text, so an edit that keeps the text keeps the state. */
  readonly id: string;
  readonly text: string;
  /** OK needs a second tap within 4 s on the glasses; open critical items are named before export. */
  readonly critical: boolean;
  /** Counts as open until a photo is attached to it on the phone. */
  readonly photo: boolean;
}

export interface CheckRoom {
  readonly name: string;
  readonly items: readonly CheckItem[];
}

export interface Checklist {
  readonly rooms: readonly CheckRoom[];
}

export type CheckStatus = "ok" | "defect";

export interface ItemCheck {
  readonly status: CheckStatus;
  readonly at: number;
}

export type ItemState = "open" | CheckStatus;

const ROOM = /^#+\s*(.*)$/;
const BULLET = /^(?:[-*+•]\s*(?:\[[ xX]?\]\s*)?)/;
const PHOTO = /\[(?:foto|photo)\]|📷️?/gi;

const GENERAL: Readonly<Record<Locale, string>> = { de: "Allgemein", en: "General" };

/** Reads the plain-text syntax above. Never throws; lines without text are skipped. */
export function parseChecklist(text: string, locale: Locale = "en"): Checklist {
  const rooms: { name: string; items: CheckItem[] }[] = [];
  const taken = new Set<string>();
  let room: { name: string; items: CheckItem[] } | null = null;

  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const heading = ROOM.exec(line);
    if (heading) {
      const name = oneLine(heading[1] ?? "");
      if (!name) continue;
      room = { name, items: [] };
      rooms.push(room);
      continue;
    }
    let body = line.replace(BULLET, "").trim();
    let critical = false;
    if (body.startsWith("!")) { critical = true; body = body.slice(1).trim(); }
    const photo = PHOTO.test(body);
    PHOTO.lastIndex = 0;
    const itemText = oneLine(body.replace(PHOTO, " "));
    if (!itemText) continue;
    if (!room) { room = { name: GENERAL[locale], items: [] }; rooms.push(room); }
    room.items.push({ id: uniqueId(room.name + "/" + itemText, taken), text: itemText, critical, photo });
  }
  return { rooms: rooms.filter((r) => r.items.length > 0) };
}

/** The checklist as the phone's text box shows it; parsing it again gives the same checklist. */
export function checklistText(checklist: Checklist, locale: Locale = "en"): string {
  const marker = locale === "de" ? "[foto]" : "[photo]";
  return checklist.rooms.map((room) => ["# " + room.name, ...room.items.map((item) =>
    (item.critical ? "! " : "") + item.text + (item.photo ? " " + marker : ""))].join("\n")).join("\n\n");
}

export function allItems(checklist: Checklist): CheckItem[] {
  return checklist.rooms.flatMap((room) => room.items);
}

export function itemCount(checklist: Checklist): number {
  return allItems(checklist).length;
}

/** The item and its room, or null when the checklist no longer has it. */
export function findItem(checklist: Checklist, id: string): { room: CheckRoom; item: CheckItem } | null {
  for (const room of checklist.rooms) {
    const item = room.items.find((candidate) => candidate.id === id);
    if (item) return { room, item };
  }
  return null;
}

// ---- state -------------------------------------------------------------------------------

export function itemState(inspection: Inspection, item: CheckItem): ItemState {
  return inspection.checks?.[item.id]?.status ?? "open";
}

/** A photo is attached to an entry of this item (a defect, or a photo taken for it on the phone). */
export function hasPhoto(inspection: Inspection, item: CheckItem): boolean {
  return inspection.entries.some((entry) => entry.itemId === item.id && entry.attachment !== undefined);
}

export function photoMissing(inspection: Inspection, item: CheckItem): boolean {
  return item.photo && !hasPhoto(inspection, item);
}

/** Checked (OK or defect) and, when one is required, with a photo. */
export function itemDone(inspection: Inspection, item: CheckItem): boolean {
  return itemState(inspection, item) !== "open" && !photoMissing(inspection, item);
}

/** Records the state of one item. */
export function setCheck(inspection: Inspection, itemId: string, status: CheckStatus, now: number): Inspection {
  return { ...inspection, checks: { ...(inspection.checks ?? {}), [itemId]: { status, at: now } } };
}

export interface Progress {
  readonly done: number;
  readonly total: number;
  /** Items that need a photo and have none yet (checked or not). */
  readonly missingPhotos: number;
  /** Critical items not checked yet. */
  readonly criticalOpen: number;
  readonly defects: number;
}

export function roomProgress(inspection: Inspection, room: CheckRoom): Progress {
  let done = 0, missingPhotos = 0, criticalOpen = 0, defects = 0;
  for (const item of room.items) {
    if (itemDone(inspection, item)) done++;
    if (photoMissing(inspection, item)) missingPhotos++;
    const state = itemState(inspection, item);
    if (item.critical && state === "open") criticalOpen++;
    if (state === "defect") defects++;
  }
  return { done, total: room.items.length, missingPhotos, criticalOpen, defects };
}

export function checklistProgress(inspection: Inspection): Progress {
  const total = { done: 0, total: 0, missingPhotos: 0, criticalOpen: 0, defects: 0 };
  for (const room of inspection.checklist?.rooms ?? []) {
    const part = roomProgress(inspection, room);
    total.done += part.done; total.total += part.total; total.missingPhotos += part.missingPhotos;
    total.criticalOpen += part.criticalOpen; total.defects += part.defects;
  }
  return total;
}

/** Where a walk through the room picks up: the first item that is not done, else the first. */
export function firstOpenItem(inspection: Inspection, room: CheckRoom): number {
  const index = room.items.findIndex((item) => !itemDone(inspection, item));
  return index === -1 ? 0 : index;
}

/** The first room with something left to do, else the first. */
export function firstOpenRoom(inspection: Inspection): number {
  const rooms = inspection.checklist?.rooms ?? [];
  const index = rooms.findIndex((room) => { const p = roomProgress(inspection, room); return p.done < p.total; });
  return index === -1 ? 0 : index;
}

// ---- export warning ---------------------------------------------------------------------

export interface ExportWarning {
  /** Rooms with at least one required photo missing. */
  readonly roomsWithoutPhoto: readonly string[];
  /** Critical items nobody checked yet. */
  readonly criticalOpen: readonly { readonly room: string; readonly item: string }[];
}

/** What the phone names before a report goes out; null when there is nothing to warn about. */
export function exportWarning(inspection: Inspection): ExportWarning | null {
  const checklist = inspection.checklist;
  if (!checklist) return null;
  const roomsWithoutPhoto: string[] = [];
  const criticalOpen: { room: string; item: string }[] = [];
  for (const room of checklist.rooms) {
    if (room.items.some((item) => photoMissing(inspection, item))) roomsWithoutPhoto.push(room.name);
    for (const item of room.items) {
      if (item.critical && itemState(inspection, item) === "open") criticalOpen.push({ room: room.name, item: item.text });
    }
  }
  return roomsWithoutPhoto.length === 0 && criticalOpen.length === 0 ? null : { roomsWithoutPhoto, criticalOpen };
}

/** "3 Räume ohne Pflichtfoto, 1 kritischer Punkt offen" — one line, singular and plural right. */
export function warningSummary(warning: ExportWarning, locale: Locale): string {
  const rooms = warning.roomsWithoutPhoto.length;
  const critical = warning.criticalOpen.length;
  const parts: string[] = [];
  if (locale === "de") {
    if (rooms > 0) parts.push(rooms === 1 ? "1 Raum ohne Pflichtfoto" : rooms + " Räume ohne Pflichtfoto");
    if (critical > 0) parts.push(critical === 1 ? "1 kritischer Punkt offen" : critical + " kritische Punkte offen");
  } else {
    if (rooms > 0) parts.push(rooms === 1 ? "1 room without a required photo" : rooms + " rooms without a required photo");
    if (critical > 0) parts.push(critical === 1 ? "1 critical item open" : critical + " critical items open");
  }
  return parts.join(", ");
}

// ---- stored data --------------------------------------------------------------------------

/** A checklist read back from storage; anything malformed is dropped rather than trusted. */
export function sanitizeChecklist(value: unknown): Checklist | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rooms = (value as { rooms?: unknown }).rooms;
  if (!Array.isArray(rooms)) return undefined;
  const clean: CheckRoom[] = [];
  for (const candidate of rooms) {
    const room = candidate as { name?: unknown; items?: unknown };
    if (typeof room?.name !== "string" || !Array.isArray(room.items)) continue;
    const items: CheckItem[] = [];
    for (const raw of room.items) {
      const item = raw as Partial<CheckItem>;
      if (typeof item?.id !== "string" || typeof item.text !== "string" || !item.text.trim()) continue;
      items.push({ id: item.id, text: item.text, critical: item.critical === true, photo: item.photo === true });
    }
    if (items.length > 0) clean.push({ name: room.name, items });
  }
  return clean.length > 0 ? { rooms: clean } : undefined;
}

export function sanitizeChecks(value: unknown): Record<string, ItemCheck> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const checks: Record<string, ItemCheck> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const check = raw as Partial<ItemCheck>;
    if ((check?.status === "ok" || check?.status === "defect") && typeof check.at === "number") checks[id] = { status: check.status, at: check.at };
  }
  return Object.keys(checks).length > 0 ? checks : undefined;
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = base + "#" + n;
  taken.add(id);
  return id;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ---- templates ------------------------------------------------------------------------------

export type TemplateId = "flat" | "car";

const TEMPLATES: Readonly<Record<Locale, Readonly<Record<TemplateId, string>>>> = {
  de: {
    flat: `# Flur
Wände und Decke ohne Schäden
Boden ohne Kratzer
Lichtschalter und Steckdosen
! Rauchmelder getestet
Wohnungstür und Schloss

# Küche
Herd und Backofen sauber
! Herd aus, Gas abgedreht
Kühlschrank leer und sauber
Spüle und Armatur dicht
Dunstabzug und Filter sauber
Fenster und Rahmen [foto]

# Bad
Fliesen ohne Risse
WC und Spülung
Waschbecken und Armatur dicht
Dusche/Wanne und Silikonfugen [foto]
Lüftung frei

# Wohnzimmer
Wände, Bohrlöcher verschlossen
Boden [foto]
Fenster und Rollläden
Heizkörper

# Schlafzimmer
Wände und Decke
Boden
Fenster und Rollläden

# Zähler und Schlüssel
! Strom abgelesen [foto]
! Wasser abgelesen [foto]
! Heizung/Gas abgelesen [foto]
! Alle Schlüssel übergeben`,
    car: `# Außen
Front und Stoßstange [foto]
Heck und Stoßstange [foto]
Linke Seite [foto]
Rechte Seite [foto]
Felgen und Reifen
! Windschutzscheibe ohne Steinschlag [foto]
Scheinwerfer und Leuchten

# Innen
Sitze sauber und heil
Fußraum und Kofferraum
Keine Warnleuchten
! Kilometerstand [foto]
! Tankfüllung/Ladestand [foto]

# Zubehör
Warndreieck und Verbandskasten
Ladekabel oder Reserverad
! Schlüssel und Fahrzeugschein`,
  },
  en: {
    flat: `# Hallway
Walls and ceiling undamaged
Floor without scratches
Light switches and sockets
! Smoke alarm tested
Front door and lock

# Kitchen
Hob and oven clean
! Hob off, gas turned off
Fridge empty and clean
Sink and tap not leaking
Extractor hood and filter clean
Window and frame [photo]

# Bathroom
Tiles without cracks
Toilet and flush
Basin and tap not leaking
Shower/bath and sealant [photo]
Ventilation clear

# Living room
Walls, drill holes filled
Floor [photo]
Windows and blinds
Radiators

# Bedroom
Walls and ceiling
Floor
Windows and blinds

# Meters and keys
! Electricity meter read [photo]
! Water meter read [photo]
! Heating/gas meter read [photo]
! All keys handed over`,
    car: `# Outside
Front and bumper [photo]
Rear and bumper [photo]
Left side [photo]
Right side [photo]
Wheels and tyres
! Windscreen without chips [photo]
Headlights and lights

# Inside
Seats clean and intact
Footwells and boot
No warning lights
! Mileage [photo]
! Fuel/charge level [photo]

# Accessories
Warning triangle and first-aid kit
Charging cable or spare wheel
! Keys and registration papers`,
  },
};

/** A starting point the user copies into the text box and edits. */
export function templateText(id: TemplateId, locale: Locale): string {
  return TEMPLATES[locale][id];
}
