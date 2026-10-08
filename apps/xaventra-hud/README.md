# Xaventra HUD

**Quietglass** · See what your [Xaventra](https://github.com/samuelvoltarius/xaventra) agent is doing, answer its questions with yes or no, and talk to it — on the Even G2.

> **Auf Deutsch, kurz:** Xaventra HUD zeigt auf der Brille, woran dein
> Xaventra-Agent gerade arbeitet, und offene Rückfragen als Karten.
> **Tippen = Ja**, **Doppeltippen = Nein**, **Wischen = nächste Karte**. Karten, die
> etwas **nach außen** bewirken (drucken, schalten, senden …), brauchen einen
> **zweiten Tap** innerhalb von 4 Sekunden. **Halten = sprechen** (höchstens 15 s):
> beim Loslassen geht die Aufnahme an *deinen* Xaventra-Rechner, der sie mit
> seiner eigenen Spracherkennung versteht. Ein „Ja“/„Nein“ beantwortet die offene
> Karte, alles andere geht als Nachricht an den Agenten, die Antwort steht auf der
> Brille. Ein gesprochenes „Ja“ bestätigt **nie** eine Aktion nach außen – dafür
> bleibt der Tap. Ohne offene Karte beendet Doppeltippen die App (mit Rückfrage).
> Die App folgt der Handy-Sprache (Deutsch/Englisch).
>
> **In 3 Schritten loslegen** (Details: [Xaventra `docs/EVEN_G2.md`](https://github.com/samuelvoltarius/xaventra/blob/main/docs/EVEN_G2.md))
> 1. In Xaventra den Even-G2-Dienst einschalten (`channels.evenG2.enabled`, Token
>    `NOVA_EVEN_G2_TOKEN`) und per `tailscale serve --bg --https=8790 http://127.0.0.1:18790`
>    im Tailnet über https erreichbar machen. **Niemals** `tailscale serve reset`.
> 2. In der Even-App bei Xaventra HUD eintragen: **Adresse des Xaventra-Endpunkts**
>    (`https://<dein-rechner>.<dein-tailnet>.ts.net:8790`) und **Token (NOVA_EVEN_G2_TOKEN)**,
>    dann **Speichern und verbinden**.
> 3. Auf der Brille: tippen, doppeltippen, wischen oder halten und sprechen.

Use `?demo=1` on the development URL to run against built-in sample data
(nothing is sent, no server needed).

---

## What it does

| Gesture | Meaning |
|---|---|
| **Tap** | Yes. A card that acts outside (`physisch`, `nach außen`) needs a **second tap within 4 s**. |
| **Double tap** | No. With no open question: asks the system to quit the app (you can cancel). |
| **Swipe** | Next / previous question |
| **Hold** | Speak (at most 15 s, shown as **● MIC**). Release sends. Double tap cancels. |

The screen: the header (`Xaventra · 14:32`, or `(offline)`), what Xaventra is
working on (`> …`), the current question with its position and effect, and a
hint row. Seven rows of 46 characters at most, in German and English.

### Voice

Hold, speak, release. The recording goes to **your own Xaventra server**
(`POST /hud/voice`), which transcribes it with its own speech recognition and
decides what it was:

| You say | What happens |
|---|---|
| "Ja" / "yes" / "okay" with a card open | The card is answered yes. Cards that act outside only get *armed*: the glasses show "Tap again = confirm YES", and the tap sends it. |
| "Nein" / "no" / "stopp" with a card open | The card is answered no. |
| Anything else | It goes to the agent as a normal message; the reply appears on the glasses with what was understood (`Du: …`). A tap closes it. |
| Something unclear while a card is open | Nothing is answered: "Not clear. Say yes or no." |

"Always allow" does not exist on the glasses, and speech never confirms an
action that acts outside — that stays an explicit tap.

## Setup

### 1. Xaventra

The app talks to the Even G2 service inside the Xaventra daemon:

| Endpoint | Used for |
|---|---|
| `GET /hud?since=<version>&wait=20` | long-poll feed: status and open question cards |
| `POST /hud/answer` | `{"cardId":"…","answer":"ja"|"nein"}` |
| `POST /hud/voice?cardId=<id>` | the recording (`audio/wav`, 16 kHz, 16-bit, mono; `cardId` = the card on the glasses) → `{"transcript","action",…}` |

All three need `Authorization: Bearer <NOVA_EVEN_G2_TOKEN>`, and CORS is open
only for these paths. The service listens on `127.0.0.1` only (default port
`18790`) and is off until you enable it. Setup, rules and limits are in the
Xaventra repository, `docs/EVEN_G2.md`. **This app needs a Xaventra version
that has `POST /hud/voice`**; without it everything but voice works.

### 2. Make it reachable over HTTPS

The app is loaded over HTTPS on the phone, so the endpoint must be reachable
over `https://` — a plain `http://` address is blocked as mixed content. With
Tailscale (inside your tailnet, no Funnel):

```bash
tailscale serve --bg --https=8790 http://127.0.0.1:18790
tailscale serve status
```

Pick a port that is free on your machine. **Never run `tailscale serve reset`**
— it removes every other route you have set up.

### 3. Enter it on the phone

Open Xaventra HUD in the Even app, enter the **Xaventra endpoint address**
(`https://<your-machine>.<your-tailnet>.ts.net:8790`) and the **Token
(NOVA_EVEN_G2_TOKEN)**, then tap **Save and connect**. The token field is
write-only; leaving it empty keeps the stored token.

## Development

```bash
npm install
npm run dev        # http://127.0.0.1:5220   (add ?demo=1 for sample data)
npm run sim        # Even Hub simulator against the dev server
npm test           # vitest
npm run build      # tsc --noEmit && vite build
npm run pack       # → xaventra-hud.ehpk
```

## What has and has not been verified

Verified in tests and the Even Hub simulator: the feed, answers, the
confirming tap, voice hold/release against a mocked endpoint, the exit
request, German and English text within the display limits. **Not verified on
physical G2 hardware**, and not verified against a running Xaventra daemon
with its speech recognition — the endpoint contract is taken from the daemon's
documentation and tested with a mock.

## Privacy

See [docs/PRIVACY.md](docs/PRIVACY.md). Short: the app talks only to the
Xaventra server you enter; the microphone runs only while you hold, for at most
15 seconds; nothing is stored by the app except address and token on your
phone. No account, no tracking.
