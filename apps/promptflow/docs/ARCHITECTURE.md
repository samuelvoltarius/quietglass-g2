# PromptFlow — architecture

## Principle

The G2 is slow to change screens and has no keyboard. Two rules follow, and they
shape the whole application:

1. **One screen, updated in place.** `rebuildPageContainer()` is reported to fail
   on real hardware, falling back to a full page creation that costs seconds and
   discards input meanwhile. PromptFlow therefore builds its page once and
   afterwards only calls `textContainerUpgrade()`.
2. **Typing happens on the phone.** The glasses are a read-only surface.

## Layers

```
        phone                          glasses
  ┌───────────────┐              ┌──────────────────┐
  │  ui/phone.ts  │              │  three text      │
  │  (config)     │              │  containers      │
  └───────┬───────┘              └────────▲─────────┘
          │ storage/persist.ts             │ glasses/render.ts  ← only SDK calls
          │                                │ glasses/diff.ts    ← skip no-op writes
          ▼                                │
  ┌──────────────────────────────────────────────────┐
  │                    main.ts                       │  wiring only
  └──────────────────────────────────────────────────┘
          │                │              │
          ▼                ▼              ▼
   script/parse.ts   prompter/engine  input/gestures.ts
   script/model.ts   prompter/layout  input/dispatch.ts
          └──────── pure, fully unit-tested ─────────┘
                            │
                            ▼
                    glasses/view.ts   ← decides *what* is shown (pure)
```

Everything below `main.ts` is pure: no SDK imports, no I/O, no globals. That is
where the 87 tests live. `main.ts` holds the mutable state and does nothing else
that is worth testing.

## Data flow

**Input.** `onEvenHubEvent` → `gestureFromEvent()` normalises the payload into a
named gesture plus its source (temple pad or R1 ring) → `dispatch()` turns the
gesture into a new `PrompterState` and optional effects → redraw.

**Time.** A 200 ms interval calls `tick()`. It advances `wordsRead` by
`wpm × elapsed / 60000`. When nothing moved, the state object is returned
unchanged and no redraw happens.

**Output.** `buildView()` produces `{ header, body[], footer }` from the script,
layout and state. `sameView()` compares it with what is on the display; identical
views are dropped before touching BLE.

## Why the position is words, not lines

`PrompterState.wordsRead` is a float. The line being spoken is derived with
`lineAtWords()`, and jumps convert back with `wordsBeforeLine()`.

This keeps pace independent of wrapping — the property is pinned by a test that
lays the same 12 words out as one line and as four, and asserts both take the
same time.

## Display layout

576 × 288, three stacked text containers:

| Container | ID | y | Height | Captures input |
|---|---|---|---|---|
| header | 1 | 0 | 32 | no |
| body | 2 | 36 | 214 | **yes** |
| footer | 3 | 252 | 34 | no |

Exactly one container may capture input; the body owns it. `zOrderIndex` is
unique per container, which the SDK's own validator requires.

## Error handling

- A failed draw clears `pageReady`, so the next draw rebuilds the page instead
  of leaving a stale screen. This covers relaunch and reconnect.
- `onDeviceStatusChanged` forces a rebuild when the glasses come back.
- `parseData()` tolerates partial or corrupt storage and falls back to defaults
  field by field rather than discarding the user's scripts.
- `rebuildPageContainer()` is called even though it is expected to fail: the
  call registers hardware event routing as a side effect, and skipping it leaves
  the app unable to receive input.

## Testing

```
tests/parse.test.ts      13   Markdown, sections, edge cases
tests/layout.test.ts      9   wrapping, long words, injected measurement
tests/engine.test.ts     22   pacing, clamping, transport, readouts
tests/gestures.test.ts    8   event decoding, ring detection, inversion
tests/dispatch.test.ts    9   gesture → state, section jumps
tests/view.test.ts       15   header, window, cursor, status line
tests/persist.test.ts    11   round-trip, corrupt data, collection edits
```

Text measurement is injected (`Measure`) rather than imported, so layout is
testable without font metrics and a caller holding real metrics can supply them.
