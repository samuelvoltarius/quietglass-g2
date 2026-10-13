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
| `detail` | string | no | Short text beside the reading (`"503/916 GB"`, names of failed services). Cut at 160 characters. Older apps ignore it. |

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
dependency-free host monitor for Linux. Trim `collect()` to taste.

```bash
node examples/reference-server.mjs
PORT=9000 TOKEN=secret NAME=nas node examples/reference-server.mjs
STATUS_SERVICES=nginx,user:my-bot STATUS_IGNORE_UNITS=certbot node examples/reference-server.mjs
```

It reports, each only where the machine can tell:

| id | what |
|---|---|
| `cpu`, `load` | CPU usage (from `/proc/stat`), load per core (`detail`: 1/5/15 min) |
| `memory`, `freemem`, `swap` | RAM in use (from `MemAvailable`), available GB, swap (`detail`: used/total) |
| `disk:<mount>` | usage of `/` and every local disk over 8 GB (warn 90 %, critical 95 %); `STATUS_DISKS` picks them by hand |
| `temp`, `temp_nvme` | CPU/SoC temperature (coretemp, k10temp, cpu_thermal, ACPI) and NVMe |
| `gpu`, `gpu_mem`, `gpu_temp`, `gpu_power` | first NVIDIA GPU via `nvidia-smi` |
| `net_rx`, `net_tx` | network rate of the physical interfaces, Mbit/s |
| `docker` | running containers; `warn` with the names when one is unhealthy |
| `failed` | failed systemd units (warn from 1), names in `detail`; `STATUS_IGNORE_UNITS` leaves some out |
| `svc:<name>` | each unit in `STATUS_SERVICES` (`user:` prefix = user unit) |
| `tailscale` | this node online, peers online in `detail` |
| `uptime` | hours |

Slow sources (nvidia-smi, systemctl, Docker, Tailscale, disks) are sampled in
the background every 15 s, so `/status` answers from memory in milliseconds.
No addresses, tokens or environment values are ever reported.
