import { tr, type Locale, type Messages } from "./i18n";

/**
 * Every user-facing string, German and English. Keys starting with `g.` go to
 * the glasses: `g.h.*` and `g.f.*` sit in the full-width header and footer
 * (46 characters), every other `g.*` sits in the body beside the pixel icon
 * (38 characters). The tests check both languages against those budgets.
 */
export const messages: Messages = {
  de: {
    // Glasses: header and footer
    "g.h.picker": "Welches Projekt starten?",
    "g.f.picker": "wischen = wählen · tippen = starten",
    "g.f.none": "tippen = anlegen · doppeltippen = beenden",
    "g.f.stoppedOne": "heute {total} · tippen = starten",
    "g.f.stoppedMany": "heute {total} · tippen = Projekt wählen",
    "g.f.running": "heute {total} · tippen = stopp",
    // Glasses: body
    "g.none.1": "Noch kein Projekt.",
    "g.none.2": "Tippen legt „{name}“ an –",
    "g.none.3": "oder leg am Handy eines an.",
    "g.stopped": "Keine Zeit läuft.",
    "g.project": "Projekt: {project}",
    "g.cancel": "Abbrechen",
    "g.target": "Tagesziel {target} h · noch {left}",
    "g.targetReached": "Tagesziel {target} h erreicht",

    // Shared
    "defaultProject": "Arbeit",

    // Export (CSV header only; values stay machine-readable)
    "x.csvHeader": "Datum,Projekt,Beginn,Ende,Sekunden,Stunden",

    // Phone
    "p.lede": "Arbeitszeit mit einem Tippen an der Brille – starten, stoppen, fertig.",
    "p.start": "So geht's",
    "p.running": "Läuft gerade: <b>{project}</b>. Tipp an die Brille, um zu stoppen.",
    "p.nextOne": "Tipp an die Brille, um die Zeit für <b>{project}</b> zu starten.",
    "p.nextMany": "Tipp an die Brille, wähl ein Projekt mit Wischen und tipp nochmal zum Starten.",
    "p.nextNone": "Leg unten ein Projekt an – oder tipp an die Brille, dann entsteht „{name}“.",
    "p.addDefault": "Projekt „{name}“ anlegen",
    "p.projects": "Projekte",
    "p.addLabel": "Neues Projekt",
    "p.addPlaceholder": "Kunde, Auftragsnummer, Tätigkeit …",
    "p.add": "Hinzufügen",
    "p.nameFirst": "Gib dem Projekt zuerst einen Namen.",
    "p.duplicate": "Das Projekt „{name}“ gibt es schon.",
    "p.remove": "Entfernen",
    "p.removeHint": "Entfernen behält die schon erfasste Zeit.",
    "p.today": "Heute",
    "p.todayLine": "<strong>{clock}</strong> ({hours} h) in {n} Einträgen.",
    "p.todayLineOne": "<strong>{clock}</strong> ({hours} h) in 1 Eintrag.",
    "p.allTime": "Gesamt",
    "p.nothing": "Noch nichts erfasst. Tipp an die Brille, um zu starten.",
    "p.export": "Als Tabelle exportieren (CSV)",
    "p.csvFormat": "Womit öffnest du die Tabelle?",
    "p.csv.excel-de": "Excel (Deutschland/Österreich)",
    "p.csv.standard": "Andere Programme oder englisches Excel",
    "p.exportHint": "Excel (Deutschland/Österreich): öffnet sich mit Doppelklick richtig – Strichpunkt als Trennzeichen, Komma bei den Stunden (1,50), Zeiten wie 07.10.2026 14:05. Andere Programme: Komma als Trennzeichen, Punkt bei den Stunden (1.50), Zeiten in UTC.",
    "p.target": "Tagesziel in Stunden (leer = keins)",
    "p.targetHint": "Erscheint als Strich im Tagesbalken auf der Brille.",
    "p.clear": "Liste leeren",
    "p.clearConfirm": "Wirklich alle Einträge löschen? Tipp zur Bestätigung nochmal auf „Liste leeren“.",
    "p.cleared": "Alle Einträge gelöscht.",
    "p.controls": "Bedienung an der Brille",
    "p.key.tap": "Tippen",
    "p.key.tapDo": "Gestoppt: Projekt wählen, dann tippen zum Starten · Läuft: stoppen",
    "p.key.swipe": "Wischen",
    "p.key.swipeDo": "Beim Wählen durch die Projekte blättern",
    "p.key.double": "Doppeltippen",
    "p.key.doubleDo": "ShiftClock verlassen – die Zeit läuft weiter",
    "p.controlsHint": "Verlassen stoppt die Zeit nicht. Der laufende Eintrag wird gespeichert und läuft beim nächsten Öffnen weiter. Einträge unter 10 Sekunden gelten als Vertipper und werden verworfen.",
    "p.invert": "Wischrichtung umkehren",
    "p.invertHint": "Einschalten, wenn Wischen auf deiner Brille in die falsche Richtung geht.",
    "p.saveFailed": "Konnte nicht speichern: {error}",
    "p.privacy": "ShiftClock speichert alles nur auf diesem Handy. Kein Konto, kein Server, kein Internet nötig.",
  },
  en: {
    // Glasses: header and footer
    "g.h.picker": "Start which project?",
    "g.f.picker": "swipe = choose  ·  tap = start",
    "g.f.none": "tap = create  ·  double tap = exit",
    "g.f.stoppedOne": "today {total}  ·  tap = start",
    "g.f.stoppedMany": "today {total}  ·  tap = choose project",
    "g.f.running": "today {total}  ·  tap = stop",
    // Glasses: body
    "g.none.1": "No projects yet.",
    "g.none.2": "Tap to create “{name}”,",
    "g.none.3": "or add one in the phone app.",
    "g.stopped": "stopped",
    "g.project": "project: {project}",
    "g.cancel": "Cancel",
    "g.target": "target {target} h · {left} to go",
    "g.targetReached": "target {target} h reached",

    // Shared
    "defaultProject": "Work",

    // Export (CSV header only; values stay machine-readable)
    "x.csvHeader": "date,project,start,end,seconds,hours",

    // Phone
    "p.lede": "Working time with one tap on your glasses — start, stop, done.",
    "p.start": "Getting started",
    "p.running": "Running now: <b>{project}</b>. Tap the glasses to stop.",
    "p.nextOne": "Tap the glasses to start the clock for <b>{project}</b>.",
    "p.nextMany": "Tap the glasses, choose a project with a swipe and tap again to start.",
    "p.nextNone": "Add a project below — or tap the glasses to create “{name}”.",
    "p.addDefault": "Create project “{name}”",
    "p.projects": "Projects",
    "p.addLabel": "Add a project",
    "p.addPlaceholder": "Client, job number, task …",
    "p.add": "Add",
    "p.nameFirst": "Give the project a name first.",
    "p.duplicate": "There already is a project “{name}”.",
    "p.remove": "Remove",
    "p.removeHint": "Removing a project keeps the time already recorded against it.",
    "p.today": "Today",
    "p.todayLine": "<strong>{clock}</strong> ({hours} h) across {n} entries.",
    "p.todayLineOne": "<strong>{clock}</strong> ({hours} h) across 1 entry.",
    "p.allTime": "All time",
    "p.nothing": "Nothing recorded yet. Tap the glasses to start.",
    "p.export": "Export as spreadsheet (CSV)",
    "p.csvFormat": "What will you open it with?",
    "p.csv.excel-de": "Excel (Germany/Austria)",
    "p.csv.standard": "Other programs or English Excel",
    "p.exportHint": "Excel (Germany/Austria): opens correctly with a double click — semicolons between fields, a decimal comma for hours (1,50), times like 07.10.2026 14:05. Other programs: commas between fields, a decimal point for hours (1.50), times in UTC.",
    "p.target": "Daily target in hours (empty = none)",
    "p.targetHint": "Shown as a mark on the day bar on the glasses.",
    "p.clear": "Clear log",
    "p.clearConfirm": "Really delete every entry? Tap “Clear log” again to confirm.",
    "p.cleared": "All entries deleted.",
    "p.controls": "Controls on the glasses",
    "p.key.tap": "Tap",
    "p.key.tapDo": "Stopped: choose a project, then tap to start · Running: stop",
    "p.key.swipe": "Swipe",
    "p.key.swipeDo": "Move through the project list while choosing",
    "p.key.double": "Double tap",
    "p.key.doubleDo": "Leave — the clock keeps running",
    "p.controlsHint": "Leaving the app does not stop the clock. The open entry is saved and resumes next time, so a disconnect or a closed app never loses time. Entries under 10 seconds are discarded as fumbles.",
    "p.invert": "Invert swipe direction",
    "p.invertHint": "Turn this on if swiping moves the wrong way on your glasses.",
    "p.saveFailed": "Could not save: {error}",
    "p.privacy": "ShiftClock keeps everything on this phone. No account, no sync, no server.",
  },
};

export function t(locale: Locale, key: string, vars: Record<string, string | number> = {}): string {
  return tr(messages, locale, key, vars);
}

/** The project created on first run, and by one tap when there is none. */
export function defaultProject(locale: Locale): string {
  return t(locale, "defaultProject");
}
