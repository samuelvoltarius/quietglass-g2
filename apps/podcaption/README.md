# PodCaption

**Quietglass** · Podcast-Untertitel für die Even Realities G2.

![PodCaption im Even-Hub-Simulator](docs/screenshot.png)

PodCaption kann WebVTT-, SRT-, JSON- oder Textdateien direkt vom Telefon öffnen. Optional liest die Bridge den offiziellen Podcasting-2.0-Tag `podcast:transcript` aus einem RSS-Feed. Damit bleibt die App unabhängig von Spotify. Oberfläche und Brillensteuerung unterstützen Deutsch, Englisch, Französisch, Spanisch und Italienisch; der eigentliche Untertiteltext bleibt in seiner Originalsprache.

## Start mit einem Feed

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
