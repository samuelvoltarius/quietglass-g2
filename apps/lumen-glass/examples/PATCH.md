# Letting Lumen Glass talk to LUMEN

Lumen Glass runs as a web app inside the Even app's WebView. Its requests to
LUMEN therefore come from a **different origin**, and a browser will not hand
the response to the app unless the server says it may.

LUMEN sends no CORS headers today. The symptom is misleading: the glasses show
**"LUMEN unreachable"** while `curl` reaches the same URL perfectly, because
the server did answer — the browser simply threw the answer away.

Two ways to fix it. The first is better.

---

## 1. Add CORS to LUMEN (recommended)

Three lines in `app.py`, next to the other imports and right after `api` is
created:

```python
from fastapi.middleware.cors import CORSMiddleware

api.add_middleware(
    CORSMiddleware,
    # The Even app's WebView origin. "*" will NOT work here — see below.
    allow_origins=["http://127.0.0.1:5200", "http://localhost:5200"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "Cookie"],
)
```

Replace the origins with wherever Lumen Glass is actually served from — the
Vite dev server during development, and whatever the Even app reports once the
app is packaged.

### Why not `allow_origins=["*"]`

Because Lumen Glass sends credentials, so that LUMEN can recognise the session
in closed mode. The CORS specification forbids combining a wildcard origin
with `Allow-Credentials: true`, and the browser rejects the response.

A wildcard looks like the permissive option and is in fact the one that blocks
every request. This cost an hour to find, so it is written down here.

### Is this safe?

CORS does not grant access — it only tells the browser which page may **read**
an answer. Anything that could already reach LUMEN's port still can, with or
without this. What it does mean is that a web page you visit on the same
machine could now talk to LUMEN, so keep the origin list short and specific
rather than opening it to everything.

---

### The upload route

CORS above is often added for `/api/*` only. The photo upload, however, posts
to LUMEN's web-form route `/quest/<id>/abgeben`. Lumen Glass (0.5.1+) sends it
as `/quest/<id>/abgeben?format=json` with `Accept: application/json`; a LUMEN
that answers that with CORS and JSON (`{"ergebnis": "erledigt" | "abgelehnt" |
"fehler", "meldung": "…"}`) lets the glasses show the verdict at once. If the
answer cannot be read (no CORS on that route, or an HTML redirect), the app
checks `/api/status` afterwards to see whether the quest was ticked off.

### Credentials

Lumen Glass sends no cookies (`credentials: "omit"`): `Cookie` is a forbidden
header in a browser, and a credentialed request also needs
`Access-Control-Allow-Credentials: true`. A token, if set, goes as
`Authorization: Bearer <token>`; a closed LUMEN has to accept that header to
let the glasses in. The phone page gets the token by posting name and password
once to `POST /api/anmelden` (JSON answer `{"token": "…"}`); the password is
never stored.

---

## 2. Run the proxy instead

If you would rather not touch LUMEN:

```bash
node examples/lumen-cors-proxy.mjs
```

It listens on `127.0.0.1:8078`, forwards everything to `127.0.0.1:8077`
unchanged — including the multipart photo upload and the session cookie — and
adds only the headers the browser insists on. Then point Lumen Glass at
`http://127.0.0.1:8078` in the phone app.

Set `LUMEN` and `PORT` to move either end.

This was the path used to verify Lumen Glass against a live LUMEN, so it is
known to work end to end.
