# PodCaption

**Quietglass** · Podcast-Untertitel für die Even Realities G2.

> **Kurz gesagt:** PodCaption zeigt die Untertitel einer Podcast-Folge im Takt auf der Brille – praktisch, wenn du schlecht hörst oder leise mitlesen willst. Kein Konto, kein Server.
>
> **So startest du:**
> 1. PodCaption in der Even-App installieren und öffnen.
> 2. Am Handy unter „Untertitel öffnen“ eine Datei wählen (VTT, SRT, JSON oder Text) – oder Untertitel von der Podcast-Website kopieren und unter „Oder Text einfügen“ einfügen.
> 3. Auf der Brille **tippen** = abspielen/anhalten, **wischen** = blättern, **doppeltippen** = beenden. Den Ton spielst du wie gewohnt in deiner Podcast-App.
>
> **Optional (Erweitert):** Untertitel automatisch aus einem RSS-Feed holen. Dafür läuft ein kleines Programm (`examples/podcast-bridge.mjs`) auf deinem Computer, weil die App den Feed sonst nicht lesen darf: der Bridge-Weg ist an `127.0.0.1:8789` gebunden (siehe `app.json`), und nicht jeder Feed erlaubt direkte Abrufe aus Apps (CORS).

![PodCaption im Even-Hub-Simulator](docs/screenshot.png)

PodCaption kann WebVTT-, SRT-, JSON- oder Textdateien direkt vom Telefon öffnen oder eingefügten Text übernehmen – das ist der Standardweg und braucht weder Netz noch Server. Beim ersten Start zeigt die Brille statt eines Beispiel-Podcasts eine kurze Anleitung in der gewählten Sprache. Optional liest die Bridge den offiziellen Podcasting-2.0-Tag `podcast:transcript` aus einem RSS-Feed; bietet eine Folge mehrere Transkripte an, nimmt sie zeitcodierte Formate (WebVTT, dann SRT, JSON) vor HTML oder reinem Text und versucht bei einem defekten Link das nächste. Die Wiedergabe folgt den Zeitstempeln; nur ungetakteter Text läuft im festen 4-Sekunden-Takt. Feed- und Transkriptfehler erscheinen auf dem Telefon und als eine Zeile auf der Brille. Damit bleibt die App unabhängig von Spotify. Oberfläche und Brillensteuerung unterstützen Deutsch, Englisch, Französisch, Spanisch und Italienisch; der eigentliche Untertiteltext bleibt in seiner Originalsprache.

## Erweitert: Start mit einem Feed

```powershell
$env:PODCAST_FEED_URL = "https://example.org/podcast.xml"
node examples/podcast-bridge.mjs
npm install
npm test
npm run build
npm run dev
npm run sim
```

Die Bridge akzeptiert ausschließlich Transkript-URLs, die im konfigurierten Feed vorkommen. Noch nicht auf echter G2-Hardware geprüft.
