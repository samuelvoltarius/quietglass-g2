# Status Glass

**Aigner Labs** · Homelab and service monitoring over a protocol anyone can implement.

A healthy system should cost you no attention. Status Glass shows **one line**
when everything is fine, and becomes impossible to miss when it is not.

---

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

## Controls

| Gesture | Effect |
|---|---|
| **Tap** | Acknowledge the highlighted problem |
| **Swipe** | Move through the problem list |
| **Hold** | Refresh every source now |
| **Double tap** | Leave Status Glass |

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
npm test           # 63 unit tests
npm run sim        # Even Hub simulator pointed at the dev server

node examples/reference-server.mjs   # a source to point it at
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
