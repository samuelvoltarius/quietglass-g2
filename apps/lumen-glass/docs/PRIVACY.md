# Lumen Glass — privacy

## Kurzfassung (Deutsch)

Lumen Glass spricht nur mit deinem eigenen LUMEN-Server unter der Adresse, die
du einträgst. Fotos nimmst du bewusst mit der Handykamera auf; sie gehen an
LUMEN und werden von der App nicht gespeichert. Gespeichert sind nur die
LUMEN-Adresse und ggf. ein Sitzungs-Cookie. Kein Konto, kein Tracking.
Deinstallieren löscht alles.

## Short version

Talks to your LUMEN and to nothing else.

## Permissions

| Permission (`app.json`) | Why | Used for nothing else |
|---|---|---|
| `network` (`http`, `https`) | Reach your LUMEN at the address you enter | No other host is contacted |

Photos use the SDK's user-initiated camera picker, which needs no permission
entry; the glasses have no camera.

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| LUMEN's address | Even app per-app storage, on the phone | No |
| Session cookie, if you use one | same | Only to your LUMEN |

Written through `setLocalStorage()` under `quietglass.lumenglass.v1`.

**No quests, photos, moth history or light data are stored here.** LUMEN
already holds all of it; a second copy on the phone would only be a second
thing to leak.

## Photos

The glasses have no camera. Tapping opens your phone's own camera through the
SDK's user-initiated picker. The picture is handed to LUMEN and then dropped —
it is not written to the phone by this app, not cached, and not sent anywhere
else.

## The session cookie

Only needed if you run LUMEN in closed mode. It is sent in a request header,
never in a URL, and the phone app shows only that it is set and how long it is.

## Where your data goes

Exactly one place: the address you entered. If that is `127.0.0.1` or a machine
on your own network — which is how LUMEN is normally run — nothing leaves the
house at all.

Lumen Glass has no vendor service, no account, no telemetry and no analytics.

## A note on CORS

Making LUMEN send CORS headers does not grant anyone access to it. It only
tells the browser which page may read an answer it already received. Keep the
origin list specific rather than opening it to everything; the patch notes
explain why.

## Removing your data

Clear the address and session cookie in the phone app to forget your LUMEN.
Uninstalling removes everything.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
