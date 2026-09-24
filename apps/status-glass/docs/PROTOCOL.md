# The Status Glass protocol

Deliberately small. If a protocol needs a client library, nobody writes an
integration for their own homelab.

A source answers an HTTP `GET` with this JSON:

```json
{
  "name": "nas",
  "timestamp": 1790289533685,
  "metrics": [
    { "id": "cpu",  "label": "CPU",  "value": 34,  "unit": "%",  "warn": 80, "critical": 95 },
    { "id": "free", "label": "Free", "value": 31,  "unit": "GB", "warn": 2,  "critical": 0.5,
      "lowerIsWorse": true },
    { "id": "web",  "label": "Web",  "state": "ok" }
  ]
}
```

## Fields

### Report

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | no | Shown on the glasses. Falls back to the configured name. |
| `metrics` | array | **yes** | The readings. May be empty. |
| `timestamp` | number | no | Producer's time in ms. |

### Metric

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | no | Stable identifier. Used for acknowledgement. Generated if absent. |
| `label` | string | no | Shown on the glasses. Defaults to `id`. |
| `value` | number | one of | Numeric reading. |
| `state` | string | one of | `ok` · `warn` · `critical` · `unknown`. Wins over thresholds. |
| `unit` | string | no | Appended to the value. |
| `warn` | number | no | Threshold for `warn`. |
| `critical` | number | no | Threshold for `critical`. |
| `lowerIsWorse` | boolean | no | Invert the comparison, for free space and similar. |

A metric needs **either** `value` **or** `state`. One with neither is dropped
and reported as a warning.

## Rules

- **Unknown fields are ignored.** A source may send extra data.
- **A metric with no thresholds is never judged** — it is displayed but always
  counts as healthy. Useful for context like uptime.
- **An unreachable or stale source is `unknown`, never `ok`.** Silence must
  never look like health.
- Anything older than **120 seconds** counts as stale.


## Actions (optional)

A source may offer things the user can trigger from the glasses. **Sources are
read-only by default** — a source that lists no actions cannot be told to do
anything.

```json
{
  "name": "home",
  "metrics": [ ... ],
  "actions": [
    { "id": "kitchen_light", "label": "Kitchen light" },
    { "id": "all_off",       "label": "Everything off", "confirm": true }
  ]
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | **yes** | Sent back when the action is triggered. Must be unique. |
| `label` | string | no | Shown on the glasses. Defaults to `id`. |
| `confirm` | boolean | no | `true` makes the glasses require a second tap. |

An action without an `id`, or with an `id` already used, is dropped and
reported as a warning — a duplicate would run the wrong thing.

### Running one

The glasses POST to the **same URL with the last path segment replaced by
`action`**, so `https://host/status` becomes `https://host/action`:

```
POST https://host/action
Authorization: Bearer <token>
Content-Type: application/json

{"id": "kitchen_light"}
```

Any 2xx response counts as success. The id travels in the body rather than the
path, so it needs no escaping and does not appear in server log lines.

### Who decides what is dangerous

**The source, not the app.** Only your server knows whether an action dims a
lamp or unlocks a door, so `confirm` is set there. Set it for anything you
would not want triggered by a stray tap.

The app adds its own guard on top: a pending confirmation is cancelled the
moment the selection moves, so the tap after a swipe can never run the action
that was highlighted before it.

### The allow-list belongs on your server

A source should expose a short, fixed list of actions and refuse everything
else — never map the incoming id onto an arbitrary service call. The Home
Assistant adapter in `examples/` shows the pattern: unknown ids get a 404, and
a client cannot smuggle its own service name into the request.

## Authentication

Send a bearer token:

```
Authorization: Bearer <token>
```

Status Glass never puts the token in the URL, because URLs end up in proxy and
server logs.

## Transport

`https://` is strongly preferred. Plain `http://` is permitted because homelab
services routinely lack certificates, but everything — including the token —
travels in the clear. The phone app marks such sources.

The app polls; a source that fails backs off exponentially to a five-minute
ceiling and recovers on the next success.

## CORS

Status Glass runs inside a WebView, so the source must allow the request:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Authorization
```

## Reference implementation

[`examples/reference-server.mjs`](../examples/reference-server.mjs) — complete,
dependency-free, about a hundred lines. Replace `collect()` and you are done.

```bash
node examples/reference-server.mjs
PORT=9000 TOKEN=secret NAME=nas node examples/reference-server.mjs
```
