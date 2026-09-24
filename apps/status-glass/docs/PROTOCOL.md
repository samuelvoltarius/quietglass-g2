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
