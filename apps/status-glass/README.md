# Status Glass

**Quietglass** · Homelab and service monitoring over a protocol anyone can implement.

A healthy system should cost you no attention. Status Glass shows **one line**
when everything is fine, and becomes impossible to miss when it is not.

---

![On the glasses](docs/screenshot.png)

*Captured from the Even Hub simulator at the real 576 × 288.*

## The idea

Existing G2 status apps are wired to one thing — a specific dashboard, a
specific service, the author's own setup. Status Glass instead defines a
**tiny JSON shape** and reads anything that speaks it.

```json
{
  "name": "nas",
  "metrics": [
    { "id": "cpu",  "label": "CPU",  "value": 34, "unit": "%",  "warn": 80, "critical": 95 },
    { "id": "web",  "label": "Web",  "state": "ok" }
  ]
}
```

That is the entire integration surface. A shell script with `echo` can be a
source. Full specification: [docs/PROTOCOL.md](docs/PROTOCOL.md).

A complete dependency-free reference server is included in
[`examples/reference-server.mjs`](examples/reference-server.mjs) — replace one
function and point the app at it.

## What you see

**Everything healthy:**

```
4 of 4 ok
                                                    all ok
```

**Something wrong:**

```
CRITICAL  3

> ! nas Disk 99%
  · nas RAM 85%
  ? pi unreachable

+1 more  ·  tap = acknowledge
```

Worst first. Acknowledged problems sink to the bottom with `(ack)` — **they are
never hidden**, they just stop being the headline. If a metric recovers and then
fails again, the acknowledgement is cleared and it shouts anew.

## Silence never looks like health

The failure mode that makes monitoring worthless is a dashboard showing green
because it cannot reach anything. In Status Glass:

- A source that **cannot be reached** is `unknown`, never `ok`.
- A source that has **not answered for 120 seconds** is stale, and stale is
  `unknown`.
- Both appear in the problem list as problems.

There are tests asserting each of these, because it is the property that
matters most.

## Controlling things, not just watching them

A source can offer **actions** — toggle a light, run a scene, restart a
service. They live on a **separate screen**, reached by holding the temple pad,
because monitoring is something you glance at and switching your lights is
something you do deliberately. A stray tap on the dashboard can never trigger
anything.

```
Actions

> ! home Everything off
    home Kitchen light
    nas  Restart media server

tap = confirm first  ·  hold = back
```

Actions the source marks with `confirm` need a **second tap**, shown as
`CONFIRM:`. Moving the selection cancels a pending confirmation, so the tap
after a swipe can never run what was highlighted before it.

**Sources are read-only by default.** One that lists no actions cannot be told
to do anything at all.

## Home Assistant

[`examples/home-assistant-adapter.mjs`](examples/home-assistant-adapter.mjs)
turns Home Assistant into a Status Glass source — readings **and** control.

```bash
HA_URL=http://homeassistant.local:8123 HA_TOKEN=<long-lived token> node examples/home-assistant-adapter.mjs
```

Edit two lists at the top: `METRICS` for what to show, `ACTIONS` for what may
be triggered. That is the whole configuration.

**Your Home Assistant token never reaches the glasses.** It stays in the
adapter, on a machine you control. The glasses only ever see the handful of
readings and actions you configured — they cannot browse your house, and a lost
phone does not hand anyone control of it.

`ACTIONS` is an **allow-list**: anything not named there is refused with a 404,
and a client cannot smuggle its own service call into the request. Verified
against a stand-in Home Assistant, including both refusal paths.

## Controls

| Gesture | Status screen | Actions screen |
|---|---|---|
| **Tap** | Acknowledge the highlighted problem | Run it — or confirm first |
| **Swipe** | Move through the problem list | Move through the actions |
| **Hold** | Open the actions screen (or refresh, if none) | Back to status |
| **Double tap** | Leave Status Glass | Leave Status Glass |

## Polling and failure

Each source polls on its own timer, so one dead host never slows the others. A
failing source backs off exponentially to a five-minute ceiling — a server that
is down is not hammered — and returns to its normal interval on the next
success.

## Security

- Tokens go in an `Authorization` header, **never in the URL**, because URLs end
  up in proxy and server logs.
- Tokens are never logged and never shown in full in the phone app — only
  "set (24 chars)".
- Error text on the glasses is shortened and never contains the URL or headers.
- `https://` is preferred; plain `http://` is permitted for LAN services without
  certificates but is marked as unencrypted in the phone app.

## Install

```bash
npm install
npm run dev        # phone UI + app on http://127.0.0.1:5196
npm run build      # typecheck + production bundle
npm test           # 87 unit tests
npm run sim        # Even Hub simulator pointed at the dev server

node examples/reference-server.mjs         # a plain source to point it at
node examples/home-assistant-adapter.mjs   # or your own Home Assistant
```

## Known limitations

| Limitation | Detail |
|---|---|
| HTTP polling only | The WebSocket push transport described in the protocol is not implemented in 0.1.0. Polling covers every source we have needed so far. |
| No history or graphs | Status Glass answers "is anything wrong right now". For trends, use the system that produced the numbers. |
| Acknowledgements are per session | They are not persisted; restarting the app clears them. |
| No alert sound | The G2 has no speaker. |
| Not verified on hardware | Built and tested against SDK 0.0.16 and the simulator. |

## Roadmap

- The WebSocket transport, for sources that would rather push.
- Persisted acknowledgements with an expiry.
- A Home Assistant example mapping entities onto the protocol.

## License

MIT — see [LICENSE](LICENSE).
