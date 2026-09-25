# Lumen Glass

**Quietglass** · Your LUMEN moth, in view — so the thing that gets you outside is where you can see it.

[LUMEN](https://github.com/) is a self-hosted app built around a moth that
lives on light. It gets tired when you stop photographing, and it never dies —
a bad week must not kill the thing, or you never open it again.

Lumen Glass puts that moth on your glasses, together with the quest and the
minutes until the next golden hour. The photo you take with your phone goes
straight back to LUMEN.

---

![On the glasses](docs/screenshot.png)

*A live LUMEN: moth curled up, the real quest, golden hour in 46 minutes.*

## Why this belongs on glasses

The moth works because you see it. On a phone that means opening an app —
which is exactly the effort the whole thing exists to remove.

On glasses it is simply there: the moth, what it wants, and the one number
that actually gets you out the door — **how long until the light is good.**

## What you see

```
   (~)
eingerollt — wartet. Er geht nicht weg.

Finde ein wiederkehrendes Muster von oben
(Acker, Parkplatz).
VIDEO — shoot this on the camera · 30 min

[----------] · golden in 46m · tap = photo
```

Five states, matching LUMEN's own thresholds. The wings tell you the state
before you read a word:

| Light | State | Shape |
|---|---|---|
| 80+ | `leuchtet` | wide open, in motion |
| 55+ | `wach` | open and steady |
| 32+ | `matt` | half folded |
| 14+ | `schläfrig` | folded together |
| 0+ | `eingerollt` | curled up, waiting |

The wording under it — "wartet. Er geht nicht weg." — comes straight from
LUMEN, so the glasses and the web app never say different things.

## Taking the photo

**Tap the temple pad**, or press **Take a photo and send it** in the phone app —
whichever is closer to hand. Both open the phone camera and hand the picture
straight to LUMEN.

The glasses have no camera, so this is the phone's own, user-initiated picker.
Nothing is kept on the glasses side; the photo goes to your LUMEN and nowhere
else.

**Video quests are flagged.** LUMEN also hands out quests asking for video,
which a still camera cannot answer — so the display says so up front rather
than letting you shoot and have it rejected.

## Controls

| Gesture | Effect |
|---|---|
| **Tap** | Take a photo and send it |
| **Hold** | Ask LUMEN for a new quest |
| **Swipe** | Refresh the moth |
| **Double tap** | Leave Lumen Glass |

## Setup

1. Run LUMEN as you normally do (its default is `127.0.0.1:8077`).
2. **Let the browser talk to it** — see [examples/PATCH.md](examples/PATCH.md).
   Three lines of CORS in LUMEN, or run the included proxy.
3. Enter the address in the phone app. The default is already LUMEN's own.

```bash
npm install
npm run dev        # phone UI + app on http://127.0.0.1:5200
npm run build      # typecheck + production bundle
npm test           # 49 unit tests
npm run sim        # Even Hub simulator pointed at the dev server
```

### The CORS trap, in one line

Without CORS headers the glasses say **"LUMEN unreachable"** while `curl`
reaches the same URL fine — the server answered, the browser discarded it. And
`allow_origins=["*"]` does **not** fix it, because the app sends credentials
and the specification forbids that combination. Details in
[examples/PATCH.md](examples/PATCH.md).

## Privacy

Lumen Glass talks to **your** LUMEN and to nothing else. There is no vendor
service and no account.

- Photos go straight to LUMEN; nothing is stored on the glasses side.
- Only the address and, if you run LUMEN in closed mode, a session cookie are
  saved on the phone. The cookie is sent as a header, never in a URL, and is
  never shown in full.
- No quests, no photos and no history are duplicated here — LUMEN already has
  all of it, and a second copy would only be a second thing to leak.

## Known limitations

| Limitation | Detail |
|---|---|
| Needs CORS on LUMEN | See above. A one-time setup. |
| Video quests | Can be seen but not answered from the glasses; flagged on the display. |
| No feed, no shop, no series | Those are rich screens that belong on the phone. This shows the moth, the quest and the light. |
| Not verified on hardware | Built and tested against SDK 0.0.16 and the simulator — but against a **live LUMEN**, not a mock. |

## Roadmap

- Show the current theme ("Blaue Stunde") and the streak more prominently.
- A gentle nudge when a good light window opens and the moth is low.
- Accept the quest's `geraet` hint — LUMEN already says which camera it means.

## License

MIT — see [LICENSE](LICENSE).
