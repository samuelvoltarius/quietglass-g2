# PromptFlow

**Quietglass** · A distraction-free teleprompter for Even Realities G2 smart glasses.

Your script sits in your field of view. It scrolls at the pace you speak, not at
the pace of a timer, and one tap starts or stops it. Nothing else competes for
your attention while you are talking.

---

![On the glasses](docs/screenshot.png)

*Captured from the Even Hub simulator at the real 576 × 288.*

## Why word-based pacing

Most teleprompters scroll by pixels or lines per second. On a 576 × 288 display
with no font control, line length varies a lot: a line can hold two words or
nine. Scrolling a line per interval therefore makes the delivery speed lurch
around with the text.

PromptFlow counts **words read** instead. Speed is set in words per minute, and
the position is derived from that — so 130 wpm is 130 wpm whether the paragraph
wrapped into three lines or seven.

## Reading modes

| Mode | Speed | Lines | For |
|---|---|---|---|
| **Presenter** | 110 wpm | 4 | Slides. You improvise; the script is a safety net. |
| **Speech** | 130 wpm | 5 | Read aloud verbatim at a steady pace. |
| **Video** | 145 wpm | 3 | To camera. Fewer words keeps your eyes still. |
| **Notes** | — | 6 | Manual reference. No auto-scroll at all. |

Every preset can be overridden on the phone.

## Controls

| Gesture | Paused | Reading |
|---|---|---|
| **Tap** | Start | Pause |
| **Swipe** | Move through the script | Adjust speed ±10 wpm |
| **Long press** | Jump to next section | Jump to next section |
| **Double tap** | Leave PromptFlow | Leave PromptFlow |

The **R1 ring** works exactly like the temple pads. PromptFlow recognises it as
a separate input source, so a future version can give it its own bindings.

Swiping while reading deliberately does *not* move your position — you are
mid-sentence, and losing your place is worse than a slightly wrong speed.

## Script format

Markdown or plain text, pasted on the phone.

```markdown
# Quarterly review          ← the title

Opening paragraph, spoken as one beat.

## Results                  ← starts a section

Another paragraph.

- a list item is its own beat
- so is this one
```

- The first `# Heading` titles the script. Later headings open **sections**,
  which drive the header line and long-press jumps.
- Blank lines separate paragraphs; single newlines are joined.
- Emphasis (`**bold**`, `*italic*`, `` `code` ``) is **stripped** — the glasses
  expose no font styling, so the words are kept and the markup discarded.
- Link text is kept, the URL dropped.

## Install

```bash
npm install
npm run dev        # phone UI + app on http://127.0.0.1:5190
npm run build      # typecheck + production bundle in dist/
npm test           # 87 unit tests
```

Use `127.0.0.1` rather than `localhost` — on some systems `localhost` resolves
to IPv6 first and the preview stays blank.

### On the glasses

1. `npm run build`
2. Package `dist/` together with `app.json` as an Even Hub bundle.
3. Sideload it, or install from Even Hub once published.
4. Open the phone companion surface, paste a script, press **Save script**.
5. Launch PromptFlow on the glasses. Tap to start.

### In the simulator

`npm run dev`, then point the Even Hub simulator at `http://127.0.0.1:5190`.
Everything except real swipe direction behaves as it does on hardware.

## Privacy

PromptFlow has **no network code**. There is no endpoint to configure, no
telemetry, no account. Your scripts are stored through the Even app's per-app
storage on your phone and never leave it. `app.json` requests **no permissions**
— not even the microphone, because 0.1.0 does not listen.

See [docs/PRIVACY.md](docs/PRIVACY.md).

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short: the logic is pure and
tested, the SDK layer is a thin adapter, and the display is only written when
the rendered view actually changed.

## Roadmap

- **Voice-follow (experimental).** Track the speaker's position in the script
  via speech recognition and scroll to match. Deliberately not in 0.1.0:
  it needs the microphone, a configurable recognition backend and an alignment
  algorithm that fails safely. PromptFlow must stay fully usable without it,
  so it will ship as an option that is off by default.
- Bookmarks with jump-back.
- Per-section speed overrides.

## Known limitations

| Limitation | Why |
|---|---|
| No font size control | Not exposed by the Even Hub SDK. Adjust *characters per line* instead. |
| Swipe direction may be inverted | Reported for real hardware, not reproducible in the simulator. Toggle it on the phone. |
| Screen rebuild is slow on hardware | `rebuildPageContainer` is reported to always fail on the G2, costing seconds. PromptFlow therefore never changes screens — it updates text in place. |
| Voice-follow absent | See Roadmap. |

Behaviour marked *reported* comes from community documentation and has not yet
been measured by Quietglass on its own device. It will be verified and this
table updated.

## License

MIT — see [LICENSE](LICENSE).
