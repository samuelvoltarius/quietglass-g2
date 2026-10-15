# Xaventra HUD

**Quietglass** · See what your [Xaventra](https://github.com/samuelvoltarius/xaventra) agent is doing, answer its questions with yes or no, and talk to it — on the Even G2.

> **Auf Deutsch, kurz:** Xaventra HUD zeigt auf der Brille, woran dein
> Xaventra-Agent gerade arbeitet, und offene Rückfragen als Karten.
> **Tippen** wählt in der Liste Ja / Nein, ein **zweites Tippen**
> innerhalb von 4 Sekunden sendet die Antwort. **Wischen** bewegt nur den Cursor
> und sendet nie etwas; Wischen oder **2×** bricht ein Bestätigen ab,
> sonst beendet 2× die App (mit Rückfrage; Bedienstandard QIS v1.2). Die **Hilfe**
> ist die letzte Zeile der Liste (Ja / Nein / Hilfe). **Halten = sprechen** (höchstens 2 min, Text erscheint schon beim Sprechen).
> Beim Loslassen steht das Erkannte zuerst auf der Brille: **Tippen sendet** es an
> *deinen* Xaventra-Rechner, **2× verwirft** es (ohne Live-Spracherkennung geht die
> Aufnahme beim Loslassen an Xaventra). Ein gesagtes „Ja“/„Nein“ beantwortet **nie**
> selbst: es wählt die Antwort in der Liste und schaltet sie scharf, erst dein
> Tippen sendet sie.
> Die App folgt der Handy-Sprache (Deutsch/Englisch).
>
> **In 3 Schritten loslegen** (Details: [Xaventra `docs/EVEN_G2.md`](https://github.com/samuelvoltarius/xaventra/blob/main/docs/EVEN_G2.md))
> 1. In Xaventra den Even-G2-Dienst einschalten (`channels.evenG2.enabled`, Token
>    `NOVA_EVEN_G2_TOKEN`) und per `tailscale serve --bg --https=8790 http://127.0.0.1:18790`
>    im Tailnet über https erreichbar machen. **Niemals** `tailscale serve reset`.
> 2. In der Even-App bei Xaventra HUD eintragen: **Adresse des Xaventra-Endpunkts**
>    (`https://<dein-rechner>.<dein-tailnet>.ts.net:8790`) und **Token (NOVA_EVEN_G2_TOKEN)**,
>    dann **Speichern und verbinden**.
> 3. Auf der Brille: wischen zum Wählen, zweimal tippen zum Antworten, halten zum Sprechen.

Use `?demo=1` on the development URL to run against built-in sample data
(nothing is sent, no server needed).

---

## What it does

| Gesture | Meaning |
|---|---|
| **Tap** | Arms the entry the cursor is on in the list *Yes / No / Help* (the help page opens on the second tap; the glasses' side menu is off, `SIDE_MENU`). A **second tap within 4 s** sends the answer. On recognised text: sends it. |
| **Swipe** | Moves the cursor (Yes, No of each card). It never sends anything; while an answer is armed it cancels it. |
| **2×** | Cancels an armed answer or a recording, discards recognised text; otherwise asks the system to quit the app (you can cancel). It never answers a card. |
| **Hold** | Speak (at most 2 min, shown as **● MIC**; with live speech recognition the words appear while you speak). On release the recognised text is shown first (tap = send, 2× = discard); without live text the recording is sent on release. 2× cancels. |

The screen: the header (`XAVENTRA · Frage 1/2`, or `XAVENTRA · offline`), what Xaventra is
working on (`> …`), the current question with its position and effect, and a
hint row. Seven rows of 46 characters at most, in German and English.

### Voice

Hold, speak, release. The recording goes to **your own Xaventra server**
(`POST /hud/voice`), which transcribes it with its own speech recognition and
decides what it was:

| You say | What happens |
|---|---|
| "Ja" / "yes" / "okay" with a card open | Nothing is sent yet: *Yes* is selected and armed ("Nochmal tippen = Ja senden"); your tap within 4 s sends it (QIS v1.2 #4). |
| "Nein" / "no" / "stopp" with a card open | The same for *No*. |
| Anything else | It goes to the agent as a normal message; the reply appears on the glasses with what was understood (`Du: …`). A tap closes it. |
| Something unclear while a card is open | Nothing is answered: "Not clear. Say yes or no." |

"Always allow" does not exist on the glasses, and speech never confirms an
action that acts outside — that stays an explicit tap.

**Live text (private builds).** With `VITE_LIVE_STT_URL` set at build time
(a Quietglass streaming recogniser, `wss://…`), the PCM is also streamed to that
server while you hold, and the words appear on the glasses as you speak (newest
words visible, up to 2 minutes). On release the recognised text is shown first
(`XAVENTRA · senden?`, `Tippen = senden · 2× = verwerfen`); a bare yes/no instead
selects and arms that answer on the open card (nothing is sent to `/hud/ask`).
Only the tap sends the text to `POST /hud/ask { text, cardId? }` (same reply as
`/hud/voice`). A server without that endpoint (404/405 or a refused preflight)
gets the WAV via `/hud/voice` instead; a recording whose live connection failed
(no handshake within 3 s, or dropped) is sent as WAV on release, as before. Public builds leave the variable empty
and behave exactly as before. Note: Xaventra's `/hud/voice` accepts at most
20 s of audio; longer recordings need `/hud/ask`.

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
2 minutes; nothing is stored by the app except address and token on your
phone. No account, no tracking.
