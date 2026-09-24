# FlowList

**Aigner Labs** · Hands-free checklists and workflows for Even Realities G2 smart glasses.

One step at a time, in your field of view, advanced with a single tap. For when
both hands are busy: cooking, wiring, packing, servicing, inspecting.

---

## Why one step at a time

A checklist app on a phone shows you twenty items and lets you hunt for your
place. On glasses that is the wrong shape. FlowList shows **the current step**,
large, with an optional dim preview of what comes next — and nothing else.

Finding your place again is the thing that breaks a hands-free workflow, so the
position (`3/8`), the section and the progress are always on screen.

## What makes it different

| | |
|---|---|
| **Critical steps ask twice** | A step marked `(!)` requires a second tap. It is the only place in the app that costs two taps — and only where getting it wrong is expensive. |
| **Branching** | A step can offer choices that jump elsewhere in the list. Going *back* returns where you actually came from, not to the previous line. |
| **Optional steps** | Marked steps can be skipped with a swipe; they do not count against your progress. |
| **Detail on demand** | Hold to read a step's fine print, release to hide it. Nothing is committed by looking. |
| **Shareable packs** | Export any checklist as a JSON pack and send it to anyone. No account, no server. |

## Controls

| Gesture | Effect |
|---|---|
| **Tap** | Step done · confirm a critical step · take the highlighted branch |
| **Swipe up** | Back one step |
| **Swipe down** | Skip (optional steps only) |
| **Hold** | Show the step's detail while held |
| **Double tap** | Leave FlowList |

On a branching step **both swipes move between the options**. The **R1 ring**
works exactly like the temple pads.

## Writing a checklist

Paste Markdown on the phone. An ordinary task list works unchanged:

```markdown
# Camera pre-flight

## Camera
- [ ] Battery in, spare in the bag
- [ ] Card formatted (!)
    Formatting erases everything. Offload first.
- [ ] Frame rate and shutter set

## Location
- [ ] ND filter fitted (optional)
```

| Syntax | Meaning |
|---|---|
| `# Heading` | Titles the checklist |
| `## Heading` | Opens a section, shown in the header |
| `- [ ] text` or `- text` | A step |
| `(!)` | Critical — asks for confirmation |
| `(optional)` | Skippable, excluded from progress |
| indented line | Detail text for the step above |

### Pack format

For branching and sharing, use the JSON pack format:

```json
{
  "format": "aigner-labs/flowlist@1",
  "title": "Camera pre-flight",
  "steps": [
    { "id": "card", "text": "Card formatted", "kind": "critical",
      "detail": "Formatting erases everything." },
    { "id": "where", "text": "Shooting indoors?", "choices": [
      { "label": "Indoors", "goto": "lights" },
      { "label": "Outdoors", "goto": "nd" }
    ] },
    { "id": "lights", "text": "Lights up, white balance set" },
    { "id": "nd", "text": "ND filter fitted", "kind": "optional" }
  ]
}
```

Unknown fields are ignored, so a pack written for a newer FlowList still loads.
A `goto` pointing at a step that does not exist is reported as a warning on
import and falls through in list order at runtime — a broken pack can never
strand you mid-run.

## Install

```bash
npm install
npm run dev        # phone UI + app on http://127.0.0.1:5191
npm run build      # typecheck + production bundle
npm test           # 79 unit tests
npm run sim        # Even Hub simulator pointed at the dev server
```

Use `127.0.0.1` rather than `localhost` — on some systems `localhost` resolves
to IPv6 first and the preview stays blank.

### On the glasses

1. `npm run build`
2. `npm run pack` produces the Even Hub bundle from `dist/` and `app.json`
3. Sideload it, or install from Even Hub once published
4. Open the phone companion, paste a checklist, and launch FlowList

A sample checklist is installed on first run so the format is learnable by
example. Remove it like any other.

## Privacy

FlowList has **no network code**. No endpoint, no telemetry, no account.
Checklists live in the Even app's per-app storage on your phone. Sharing works
by exporting a file — nothing is ever uploaded. `app.json` requests **no
permissions**.

See [docs/PRIVACY.md](docs/PRIVACY.md).

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The run logic is pure and
fully tested; the SDK layer is a thin adapter.

## Known limitations

| Limitation | Why |
|---|---|
| No editing on the glasses | There is no keyboard. Checklists are written on the phone. |
| No font size control | Not exposed by the Even Hub SDK. Adjust *characters per line* instead. |
| Swipe direction may be inverted | Reported for real hardware, not reproducible in the simulator. Toggle it on the phone. |
| Voice commands not implemented | Planned; see below. |

## Roadmap

- **Voice commands** ("done", "back", "skip") using the glasses microphone, for
  when your hands are not just busy but dirty. Off by default; the microphone
  permission will only be requested if enabled.
- Run history and timing per step.
- A small public index of shared checklist packs.

## License

MIT — see [LICENSE](LICENSE).
