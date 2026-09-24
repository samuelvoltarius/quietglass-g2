# FlowList — architecture

## Principle

The G2 is slow to rebuild a page and has no keyboard. Two rules follow:

1. **One screen, updated in place.** `rebuildPageContainer()` is reported to
   fail on real hardware, falling back to a full page creation that costs
   seconds and discards input meanwhile. FlowList builds its page once and
   afterwards only calls `textContainerUpgrade()`.
2. **Writing happens on the phone.** The glasses run a checklist; they never
   edit one.

## Layers

```
        phone                          glasses
  ┌───────────────┐              ┌──────────────────┐
  │  ui/phone.ts  │              │  three text      │
  │  write/import │              │  containers      │
  └───────┬───────┘              └────────▲─────────┘
          │ storage/persist.ts             │ glasses/render.ts  ← only SDK calls
          │                                │ glasses/diff.ts    ← skip no-op writes
          ▼                                │
  ┌──────────────────────────────────────────────────┐
  │                    main.ts                       │  wiring only
  └──────────────────────────────────────────────────┘
          │                │              │
          ▼                ▼              ▼
   checklist/parse.ts  checklist/run.ts  input/gestures.ts
   checklist/model.ts                    input/dispatch.ts
          └──────── pure, fully unit-tested ─────────┘
                            │
                            ▼
                    glasses/view.ts   ← decides *what* is shown (pure)
```

Everything below `main.ts` imports no SDK types and performs no I/O. That is
where the 79 tests live.

## The run state

```ts
interface RunState {
  currentId: string | null;         // null once finished
  status: Record<string, StepStatus>;
  history: string[];                // visited ids, newest last
  awaitingConfirm: boolean;
  choiceIndex: number;
}
```

Every transition — `complete`, `skip`, `back`, `moveChoice` — is a pure
function taking the checklist and returning a new state.

**`history` is the key design decision.** Branching means the previous step in
list order is often *not* where the user came from. Recording visits makes
"back" correct across branches, and a test pins exactly that.

## Why branching is flat

Steps are a flat array; a branch is a `goto` between ids. A nested tree cannot
be rendered on 576 × 288, and a flat list keeps "where am I" answerable with a
single number (`3/8`) that a user can act on.

A `goto` whose target does not exist would strand the run, so it is checked
twice: reported as a warning at import, and ignored at runtime in favour of the
next step in order.

## Critical steps

`complete()` on a critical step does not advance. It sets `awaitingConfirm`,
the view switches to `CONFIRM:` and the footer says `tap again = confirm`. The
second tap advances; a swipe up cancels.

This is the only two-tap interaction in the app. Everywhere else, one tap.

## Display layout

576 × 288, three stacked text containers:

| Container | ID | y | Height | Captures input |
|---|---|---|---|---|
| header | 1 | 0 | 32 | no |
| body | 2 | 36 | 214 | **yes** |
| footer | 3 | 252 | 34 | no |

Exactly one container may capture input; the body owns it. `zOrderIndex` is
unique per container, as the SDK's validator requires.

## Input decoding — the pitfall

A tap arrives from the SDK as:

```json
{"jsonData":{"eventSource":1},"sysEvent":{"eventSource":1}}
```

with **no `eventType`**. The payload is protobuf-derived and proto3 omits
fields holding their default value; `CLICK_EVENT` is `0`. An absent event type
therefore *means* a tap.

`gestureFromEvent()` resolves a missing code to CLICK for exactly this reason,
and `tests/gestures.test.ts` feeds in the payload above verbatim. Without this,
the app receives events and silently ignores every tap — which is how the bug
presented before it was found in the simulator.

## Error handling

- A failed draw clears `pageReady` so the next draw rebuilds the page. Covers
  relaunch and reconnect.
- `onDeviceStatusChanged` forces a rebuild when the glasses return.
- `parseData()` tolerates corrupt storage field by field rather than discarding
  the user's checklists.
- `rebuildPageContainer()` is called even though it is expected to fail: the
  call registers hardware event routing as a side effect.

## Testing

```
tests/run.test.ts        24   transitions, branching, confirmation, progress
tests/parse.test.ts      16   Markdown, packs, round-trip, malformed input
tests/view.test.ts       18   step display, choices, finished view, wrapping
tests/gestures.test.ts   12   event decoding, ring detection, proto3 omission
tests/dispatch.test.ts    9   gesture → state
```
