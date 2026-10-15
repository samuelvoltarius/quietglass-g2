# Offline-Sprachbefehle mit Vosk in der Even-App – Machbarkeit

Stand 13.10.2026 · Even Hub SDK 0.0.16 · vosk-browser 0.0.8 · **nicht auf Hardware geprüft**

## Kurz

Technisch passt es zusammen: Die Brille liefert (nach Quietglass-Praxis) 16 kHz,
16 Bit, mono – genau das, was Vosk will; vosk-browser braucht keine Threads und
kein `SharedArrayBuffer`, also auch keine besonderen Server-Header; ein
Grammatik-Modus beschränkt die Erkennung auf eine feste Befehlsliste. Die offenen
Punkte sind praktisch, nicht grundsätzlich: **≈ 300 MB Arbeitsspeicher** in der
WebView der Even-App, **≈ 45 MB Modell** plus 2,4 MB Bibliothek (gzip), die aufs
Handy müssen, und eine Bibliothek, die seit Ende 2022 nicht mehr gepflegt wird.
**Empfehlung:** erst ein Messversuch auf dem iPhone (Ladezeit, Speicher,
Echtzeitfaktor), bevor eine App darauf baut.

## 1. Audio aus dem SDK

| Punkt | Befund | Quelle |
|---|---|---|
| Einschalten | `bridge.audioControl(true, AudioInputSource.Glasses)`; aus mit `audioControl(false)`. Vorher muss eine Seite stehen. | SDK-d.ts, SDK-README |
| Ereignis | `onEvenHubEvent` → `event.audioEvent.audioPcm` (`Uint8Array`), dazu `source`, `direction` (int16 oder null), `speakerRole` | SDK-d.ts `AudioEvent` |
| Transport | „nach JSON meist `number[]` oder Base64-String“ | Kommentar im SDK-d.ts |
| Format | **Im d.ts nicht angegeben.** Quietglass-Apps (decibel-guard, field-log, nextstop) behandeln es als 16 kHz, signed 16 Bit little-endian, mono; die WAV-Dateien daraus laufen durch Whisper. | `apps/decibel-guard/src/audio/level.ts` |
| Vosk-Eingang | `acceptWaveformFloat(Float32Array, sampleRate)` mit Werten in [-1, 1); die Bibliothek multipliziert selbst mit 0x8000. | Quelltext vosk-browser 0.0.8 |

Damit ist die Kette: `audioPcm` → Bytes → Int16 LE → Float32 / 32768 → Vosk mit
16000 Hz. Kein Resampling nötig (für 48 kHz vom Handy-Mikro liegt ein linearer
Resampler bei). Umgesetzt in `src/pcm.ts`.

## 2. vosk-browser

| | |
|---|---|
| Paket | `vosk-browser` 0.0.8 (npm), letzte Version 25.12.2022, Kaldi/Vosk als WebAssembly |
| Lizenz | **Apache-2.0** (Paket und Vosk-API) – mit MIT-Apps verträglich, Lizenztext mitliefern |
| Größe | `dist/vosk.js` 5,8 MB (gzip 2,4 MB). Darin als Base64: Web-Worker samt WASM (~4,3 MB). Abhängigkeit nur `uuid`. |
| API | `createModel(url)` → `new model.KaldiRecognizer(16000, grammarJson)` → `on("result" / "partialresult")`, `acceptWaveformFloat`, `retrieveFinalResult`, `remove`, `model.terminate()` |
| Threads | Ein Worker, **kein** `SharedArrayBuffer`, keine Atomics/pthreads → keine COOP/COEP-Header nötig (die man in der Even-App ohnehin nicht setzen könnte). |
| Speicher | Emscripten-Heap startet bei 16 MB und wächst bis max. 2 GB. |
| Modell laden | Der Worker lädt `model.tar.gz` per `fetch` und legt es in IndexedDB (IDBFS) ab → beim zweiten Start aus dem Cache. Der Worker läuft unter einer `blob:`-URL, also **absolute Modell-URL** angeben. |

## 3. Deutsches Modell

| Modell | Größe | Lizenz | Bemerkung |
|---|---|---|---|
| `vosk-model-small-de-0.15` | 45 MB | Apache-2.0 | „leichtes Modell für Android/RPi“ – **das Kandidaten-Modell** |
| `vosk-model-small-de-zamia-0.3` | 49 MB | LGPL-3.0 | von Vosk selbst „nicht empfohlen“ |
| `vosk-model-de-0.21` | 1,9 GB | Apache-2.0 | Server-Modell, im Handy unbrauchbar |

Laut Vosk-Modellseite braucht ein kleines Modell etwa 300 MB Arbeitsspeicher zur
Laufzeit, und „die meisten“ kleinen Modelle erlauben eine Umstellung des
Wortschatzes (Grammatik). Ob das für `small-de-0.15` gilt, steht dort nicht
einzeln – muss im Versuch bestätigt werden (Vosk warnt im Log, wenn ein Wort
fehlt oder die Grammatik nicht geht).

## 4. Grammatik statt freier Erkennung

`new KaldiRecognizer(16000, '["licht küche an", "licht küche aus", "[unk]"]')`
beschränkt den Decoder auf diese Sätze; alles andere kommt als `[unk]`. Das
macht kurze Befehle deutlich robuster als freie Erkennung mit dem kleinen
Modell. Regeln:

- Kleinbuchstaben, Umlaute so wie im Modell-Wortschatz (`küche`, nicht `kueche`).
- Wörter, die das Modell nicht kennt, fallen still heraus → jede neue Phrase einmal testen.
- `[unk]` immer anhängen, sonst wird jede Äußerung auf den nächstbesten Befehl gezwungen.
- Neue Befehlsliste = neuer Recognizer (das Modell bleibt geladen).

## 5. Prototyp in diesem Ordner

| Datei | Inhalt |
|---|---|
| `src/pcm.ts` | SDK-Audio (Uint8Array / number[] / Base64) → Float32, Resampler |
| `src/commands.ts` | Befehlsliste → Vosk-Grammatik; Vosk-Text → Befehl (Normalisieren, Füllwörter, Umlaut-Faltung, Levenshtein pro Wort, Reihenfolge egal, Komposita, Mehrdeutigkeit = kein Treffer) |
| `src/recognizer.ts` | `createCommandRecognizer(engine, commands)` mit `pushPcm(chunk)`, `finish()`, `onResult(...)`; `createVoskEngine(model, commands)` passt ein vosk-browser-Modell an |
| `tests/` | 22 Tests (Abgleich, Grammatik, PCM, Adapter mit Fake-Modell) – ohne Bibliothek und ohne Modell lauffähig |

Beispiele aus den Tests: „bitte das licht in der küche aus“, „küche licht aus“,
„licht kuche aus“, „küchenlicht aus“ → `light.kitchen.off`; „licht küche an“
bleibt `…on` (kurze Wörter werden nie unscharf verglichen, „an“ ≠ „aus“);
„licht aus“ ohne Raum → kein Treffer statt Raten; „wie wird das wetter“ → nichts.

Nutzung in einer App (Skizze, nicht gebaut):

```ts
import { createModel } from "vosk-browser";
const model = await createModel("https://<eigener-server>/vosk-model-small-de-0.15.tar.gz");
const rec = createCommandRecognizer(createVoskEngine(model, COMMANDS), COMMANDS);
rec.onResult(({ match }) => { if (match) run(match.id); });
await bridge.audioControl(true, AudioInputSource.Glasses);
bridge.onEvenHubEvent((e) => { if (e.audioEvent) rec.pushPcm(e.audioEvent.audioPcm); });
// Loslassen / Stille: rec.finish(); bridge.audioControl(false);
```

Test: `npm install && npm test` (nur TypeScript + Vitest, keine Vosk-Bibliothek).

## 6. Risiken

| Risiko | Gewicht | Was dagegen hilft |
|---|---|---|
| **Speicher in iOS-WKWebView** (~300 MB fürs Modell, plus App). Überschreitet der WebContent-Prozess sein Budget, beendet iOS ihn ohne Fehlermeldung – die App-Seite wird leer bzw. neu geladen. | hoch | Messen (Instruments oder Jetsam-Logs). Modell beim Verlassen mit `terminate()` freigeben. |
| **Modellverteilung**: 45 MB im `.ehpk` mitliefern (Grenze des Even Hub unbekannt) oder beim ersten Start vom eigenen Server laden (exakter Origin in der Whitelist von `app.json`, CORS; danach IndexedDB-Cache, den iOS bei Platzmangel löschen darf). | hoch | Erster Versuch: eigener Server + Cache; Paketgröße beim Hub erfragen. |
| **Ladezeit**: Entpacken und Initialisieren von 45 MB in WASM auf dem Handy – vermutlich mehrere Sekunden, **nicht gemessen**. | mittel | Im Hintergrund laden, Gesten vorher verdrahten (nie vor `onEvenHubEvent` auf lange Aufgaben warten). |
| **Rechenzeit**: Single-Thread-WASM. Für Grammatik-Erkennung mit kleinem Modell vermutlich schneller als Echtzeit, **nicht gemessen**. | mittel | Echtzeitfaktor im Versuch messen (Rechenzeit / Audiodauer). |
| **App im Hintergrund**: Die WebView der Even-App wird pausiert → keine Erkennung bei gesperrtem Handy. Gilt für jede WebView-Lösung. | mittel | Nur „Halten zum Sprechen“ im Vordergrund anbieten. |
| **Bibliothek ungepflegt** (letzte Version 2022; das GitHub-Repo unter der npm-Adresse war beim Prüfen nicht erreichbar). | mittel | Apache-2.0 erlaubt einen eigenen Fork/Build; Alternativen beobachten (z. B. sherpa-onnx als WASM mit Keyword-Spotting). |
| **Audioformat nur aus der Praxis**, nicht im SDK dokumentiert. | niedrig | Im Versuch eine Sekunde als WAV ablegen und anhören. |
| Fremde Stimmen im Raum | niedrig | Frames mit `speakerRole === "other"` verwerfen. |

## 7. Empfehlung

1. **Ja zu einem Messversuch, nein zu einer Produkt-App auf Verdacht.** Eine
   Wegwerf-App „Vosk-Test“ (privater Build): Modell vom eigenen Server laden,
   Ladezeit, Speicher, Echtzeitfaktor und Trefferquote für ~10 Befehle auf dem
   iPhone messen, je 20 Versuche mit Brille.
2. Abbruchkriterium: WebView stürzt ab oder lädt neu, Laden aus dem Cache
   über 10 s, oder Echtzeitfaktor über 1.
3. Wenn es trägt: Die Abgleich-Schicht aus `src/commands.ts` ist unabhängig von
   Vosk und kann auch hinter der bestehenden Whisper-Strecke laufen –
   offline mit Vosk, online mit Whisper, dieselbe Befehlsliste.
4. Wenn es nicht trägt: Befehle weiter über Whisper am eigenen Server
   (funktioniert schon, braucht aber Netz) oder auf eine schlankere
   Keyword-Erkennung ausweichen.

## Quellen

- Even Hub SDK 0.0.16: `dist/index.d.ts` (`AudioEvent`, `audioControl`), README Abschnitt „MIC Source“
- vosk-browser 0.0.8: npm-Metadaten und README, `dist/model.d.ts`, `dist/vosk.js` (nur gelesen, nicht ausgeführt)
- Vosk-Modelle und Speicherbedarf: https://alphacephei.com/vosk/models
