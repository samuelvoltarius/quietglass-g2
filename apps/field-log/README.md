# FieldLog

**Quietglass** · Walk an inspection hands-free. Speak the defect, attach a photo, export the report.

Handover, survey, snag list, vehicle return, plant maintenance. You see
something, both hands are busy or dirty, and writing it down means stopping.
FieldLog lets you say it and carry on.

---

![On the glasses](docs/screenshot.png)

*Captured from the Even Hub simulator at the real 576 × 288.*

## The walk

1. **Tap** — dictate what you see.
2. **Tap** — stop. The transcript appears.
3. **Tap** to keep it, **swipe** to discard.
4. **Hold** to attach a photo from the phone camera.

Severity (`note` · `minor` · `major`) is set with a swipe and applies to the
next entry. Sections — Kitchen, Axle, Roof — are set on the phone and every
entry inherits the current one, so the report groups itself.

## Every transcript is confirmed

Speech recognition is imperfect, and an inspection report is a document someone
acts on: a wrong entry can become a wrong invoice or a missed fault.

So FieldLog never files a transcript silently. It shows what it heard and waits.
Keeping is one tap; discarding is one swipe. This is the one place in the app
that costs an extra gesture, and it is the right place for it.

## Your own recogniser

Audio is streamed to a speech server **you** configure — the same wire format
as Babel Glass, so one `faster-whisper` instance serves both. Leave it empty
and a mock runs that produces placeholder text and displays `MOCK`, so you can
try the app without infrastructure and can never mistake its output for a real
transcription.

## Photos

The glasses have no camera. FieldLog uses the SDK's phone-camera picker, which
is user-initiated by design — holding the temple pad opens the camera on your
phone, and the photo attaches to the entry you just made.

## Export

| Format | Contains |
|---|---|
| **Markdown** | Grouped by section, majors in bold, photos referenced by size |
| **Markdown + photos** | The same with images embedded — self-contained but large |
| **CSV** | One row per entry, for a spreadsheet |

Photos are referenced rather than embedded by default: a report with a dozen
inline base64 images is neither readable nor emailable.

## Example output

```markdown
# Handover flat 3

Started: 2026-09-25T09:14:00.000Z
Major: 1 · Minor: 2 · Notes: 0

## Kitchen

- [09:16] *minor* — Tap drips at the base
  (photo attached, 412 kB)

## Bathroom

- [09:24] **MAJOR** — Mould behind the sink, spreading to the wall
```

## Controls

| Gesture | Effect |
|---|---|
| **Tap** | Dictate · stop · keep the transcript |
| **Swipe** | Change severity · discard the transcript under review |
| **Hold** | Attach a photo from the phone camera |
| **Double tap** | Leave — stops the microphone |

## Install

```bash
npm install
npm run dev        # phone UI + app on http://127.0.0.1:5198
npm run build      # typecheck + production bundle
npm test           # 44 unit tests
npm run sim        # Even Hub simulator pointed at the dev server
```

For a speech server, use the reference implementation from Babel Glass
(`apps/babel-glass/examples/whisper-server.py`) — the wire format is identical.

## Privacy

- The microphone opens **only on an explicit tap**, with `● MIC` shown for as
  long as it is open.
- Audio goes **only to the server you configure**, and is **never stored**.
- Entries and photos stay in this app's storage on your phone until you export
  them. There is no upload and no account.
- Tokens are never logged and never shown in full.

Inspecting someone's property and photographing it carries obligations that are
yours, not the app's. FieldLog keeps everything local so that what you record
stays under your control.

## Known limitations

| Limitation | Detail |
|---|---|
| Photos live in per-app storage | Not a filesystem. The phone app shows the stored size and warns past ~4 MB; export and remove old inspections. |
| No editing text on the glasses | Correcting wording happens on the phone. |
| One inspection open at a time | Deliberate — mixing two walks is how entries end up in the wrong report. |
| Not verified on hardware | Built and tested against SDK 0.0.16; the simulator provides no meaningful speech and no camera. |

## Roadmap

- Location stamping per entry, using the SDK's `getAppLocation`.
- PDF export with photo plates.
- Re-usable inspection templates with predefined sections.

## License

MIT — see [LICENSE](LICENSE).
