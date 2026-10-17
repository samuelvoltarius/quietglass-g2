# Quietglass UI Standard (QUS v1)

Stand 17.10.2026. Gilt für jede App unter `apps/`, zusammen mit dem Bedienstandard
`BEDIENSTANDARD.md` (Gesten). Vorbilder: **Rain Lens** für das Aussehen (Brille und Handy),
**Babel Glass 1.0** für den Aufbau (wenige Modi, ruhige Laufansicht, Einstellungen am Handy).

Grundsatz: **Keine Textwand.** Was man im Gehen mit einem Blick erfassen muss, ist groß, grafisch
und an fester Stelle. Lesetext gibt es nur dort, wo Lesen der Zweck ist (Untertitel, Antworten),
und auch dann in Blöcken mit klarer Kopfzeile.

---

## 1. Brille

### 1.1 Aufbau einer App
- **Startseite:** höchstens **drei große Einträge** (die Modi bzw. Hauptziele der App), darunter
  bei Bedarf eingerückte Unterpunkte (z. B. Kunden unter „Gespräch“). Wischen wählt, Tippen startet.
  Kein Menü, keine Hilfe-Seiten (Halten und Seitenmenü erreichen die App auf der Hardware nicht).
- **Laufansicht:** ruhig. Kopfzeile = `Modus · ● live` (bzw. `‖`/`offline` als Wort), unten **eine**
  Hinweiszeile mit den zwei wichtigsten Gesten. Keine Uhr-, Kürzel- oder Helferleisten.
- **2×** = eine Ebene zurück; auf der Startseite Beenden-Dialog (Muster siehe Skill even-g2-apps 1a).
- Einrichtung (Server, Sprachen, Stimme, Personen) gehört **aufs Handy**, nie in Brillen-Listen.

### 1.2 Cockpit-Darstellung (Rain-Lens-Muster)
Status-, Werte- und Übersichtsseiten werden **als Bild gezeichnet**, nicht als Textcontainer:
das ganze Display (576×288) als ein Frame, gesendet als 4 Bild-Kacheln à 288×144
(`src/screen/frame.ts`, `draw.ts`, `text.ts`, `pixel-font.ts`, `sender.ts` aus Rain Lens).

Raster (Rain-Lens-Cockpit, `src/cockpit/compose.ts`):
```
┌ links 288 ─────────────────┐┌ rechts 288 ─────────────────┐
│ Grafik: Symbol, Karte,     ││ APPNAME              14:05  │  Kopf: klein, Pegel 8
│ Ring, Balken, Verlauf      ││ HAUPTAUSSAGE                │  Überschrift 24–44 px
│                            ││ ~25 MIN                     │
│                            ││ LABEL   LABEL   LABEL       │  Raster 3 Spalten,
│ ━━━━━━━━━╋- - - - - -      ││ Wert    Wert    Wert        │  Label 13 px, Wert 14–28 px
│ Zeitleiste / Fußnote       ││ LABEL   LABEL               │
└────────────────────────────┘└─────────────────────────────┘
```
Regeln:
- **Eine Hauptaussage** pro Seite, groß (`HEADLINE_SIZES` 44→24, `fitFont` verkleinert stufenweise).
- Weitere Werte als **Label/Wert-Zellen** (3 Spalten, Zeilenhöhe 56): Label klein und gedimmt,
  Wert groß. Keine Sätze in Zellen.
- Links eine **Grafik**, die den Zustand ohne Lesen zeigt (Symbol, Fortschrittsring, Balken, Kurve).
- Helligkeit statt Farbe: Text 15, Label 8, gedimmt 4, Raster 3 (`LEVELS`).
- Nur geänderte Kacheln senden (Key je Kachel vergleichen); Uhr ändert nur die Kachel oben rechts.
- Während der Beenden-Dialog offen sein kann, keine Kachel senden.

### 1.3 Listen und Lesetext (wo Text der Zweck ist)
- Listen: höchstens 5 sichtbare Zeilen, Auswahl mit `●`, nicht ausgewählt eingerückt, keine Nummern.
- Lesetext (Untertitel, Antworten, Notizen): Kopfzeile mit Kontext, darunter der Text, Neuestes
  unten, Wischen blättert seitenweise. Nie mehrere Absätze unterschiedlicher Art gemischt.
- Glyphen, die die Brille zeichnet: `● ○ → … · — ↑ € ×`, Umlaute, Kyrillisch. Nicht: `▸ ‖`.

---

## 2. Handy

### 2.1 Aufbau
- **Genau drei Tabs** unten (Tab-Leiste fest, eine Zeile – nie umbrechen):
  1. **Jetzt** – was gerade läuft / der aktuelle Zustand.
  2. **App-eigene Liste** (z. B. „Meine Wörter“, „Drucke“, „Fahrten“, „Verlauf“).
  3. **Einstellungen** – gruppierte Karten, Server-Karte eingeklappt sobald eingerichtet.
- **Erststart** (nichts eingerichtet): Einstellungen offen mit kurzer 3-Schritt-Checkliste;
  ohne Server läuft die Demo.

### 2.2 Aussehen (Rain-Lens-Muster, `apps/rain-lens/src/ui/phone.css`)
- Dunkel, Akzent Türkis. Kopf: Kicker `QUIETGLASS / KATEGORIE` (klein, gesperrt), Titel groß,
  rechts eine **Status-Pille** (`● verbunden`).
- **Statusbanner** (Karte mit Akzentkante links) für die eine Meldung, die gerade zählt.
- **Hero-Karte**: Label in Akzentfarbe groß-klein, **ein großer Wert**, Nebenwert rechts gedimmt.
- **Kennzahl-Raster** 2×2 in der Karte (Label klein gedimmt, Wert groß, Einheit klein darunter).
- **Ein** primärer Knopf pro Karte (gefüllt Akzent), weitere als Text-/Umrissknöpfe.
- Zeitreihen als **horizontale Karten-Leiste** (Stunden, Schritte, Einträge), nicht als Tabelle.
- Große Touch-Ziele (≥44 px), keine Absätze über 3 Zeilen; Erklärungen hinter „Mehr“ einklappen.
- Gefährliche Aktionen (löschen, zurücksetzen) mit Bestätigung, rot nur hier.

---

## 3. Umsetzung
- Gemeinsame Bausteine werden pro App kopiert (wie `src/exit.ts`), Quelle ist Rain Lens:
  `src/screen/*` (Renderer) und die CSS-Grundlagen aus `src/ui/phone.css`.
- Rollout **eine App zuerst** (Pilot), an der Brille prüfen, dann die übrigen.
- Jede App: Tests für die Startzeilen, die Laufansicht (Kopf/Fuß) und die Cockpit-Zellen
  (reine Funktionen, die aus dem Zustand das Modell bauen; Zeichnen getrennt).
