# Market Glance — privacy

## Kurzfassung (Deutsch)

Market Glance liest deine Prediction-Market-Positionen ausschließlich von
deiner eigenen lokalen Bridge auf `127.0.0.1:8793`. Erst diese Bridge — ein
Programm, das du selbst startest — fragt Polymarket (öffentliche
Wallet-Adresse) und optional Kalshi (dein API-Schlüssel) ab. Schlüssel und
Wallet bleiben in der Bridge und erreichen nie die Brille oder die App. Die
App kann nicht handeln. Gespeichert werden nur Bridge-Adresse und Sprache.
Kein Tracking. Deinstallieren löscht alles.

## Short version

Read-only. The app talks only to a bridge you run yourself; your exchange
credentials never reach the app or the glasses.

## Permissions

| Permission (`app.json`) | Why | Used for nothing else |
|---|---|---|
| `network` (`http://127.0.0.1:8793`, `http://localhost:8793`) | Poll the local market bridge every 15 s | The whitelist allows no other host |

## Where your data goes

The app sends only a plain `GET` to the bridge and receives normalized
positions (market title, side, price, P/L). It has no order, buy or sell code.

The bridge (`examples/market-bridge.mjs`) runs on your computer and is the only
part that contacts third parties:

| Service | What the bridge sends | Configured by |
|---|---|---|
| Polymarket data API (`data-api.polymarket.com`) | Your **public** wallet address | `POLYMARKET_WALLET` |
| Kalshi API (`external-api.kalshi.com`), optional | Requests signed with your API key | `KALSHI_KEY_ID`, `KALSHI_PRIVATE_KEY_PATH` |

Those services' own privacy policies apply to those requests. The Kalshi key id
and private key stay in the bridge's environment on your machine.

## What is stored

| Data | Where | Leaves the device |
|---|---|---|
| Bridge address | WebView storage of the Even app, on the phone | No |
| Display language | same | No |

Keys: `markets.endpoint`, `quietglass.locale`. Positions are held **in memory
only**.

## What is not collected

- No analytics, telemetry, crash reporting or usage statistics.
- No account, login or device identifier in the app.
- No advertising or third-party SDKs.
- No microphone, no camera, no location.

Information display only, not financial advice.

## Removing your data

Uninstalling removes the stored address and language. Stopping the bridge and
deleting its environment variables removes the credentials it was given.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
Build-time tools ship no code into the bundle.
