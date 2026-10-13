# klipper-bridge — Drucker-Brücke für Klipper Glance

Der Drucker hängt nur im LAN, das Handy kann überall sein. Diese Brücke läuft auf einem Rechner, der den Drucker
sieht (Raspberry Pi, NAS, Server), liest **Moonraker** und liefert dem Handy einen kompakten Status. Pause /
Fortsetzen / Abbrechen sind **aus**, bis du `KL_ALLOW_CONTROL=1` setzt – und werden ohne Anmeldung
(`KL_TAILSCALE_USERS` oder `TOKEN`) trotzdem verweigert. **Der Code liegt im Repo und wird nicht kopiert:**
[`apps/klipper-glance/examples/klipper-bridge.mjs`](../../../apps/klipper-glance/examples/klipper-bridge.mjs)
(Node ≥ 18, keine Abhängigkeiten). Zum Testen ohne Drucker: `mock-moonraker.mjs` im selben Ordner.

| lokal | Tailscale-Port (Vorschlag) | App-Feld / Build |
|---|---|---|
| `127.0.0.1:8898` | `8447` | „Adresse der Brücke“ = `https://<server>.<tailnet>.ts.net:8447` |

## Installieren

```bash
git clone https://github.com/samuelvoltarius/quietglass-g2 ~/quietglass-g2     # falls noch nicht da
mkdir -p ~/.config/quietglass ~/.config/systemd/user
cp .env.example ~/.config/quietglass/klipper-bridge.env && chmod 600 ~/.config/quietglass/klipper-bridge.env
$EDITOR ~/.config/quietglass/klipper-bridge.env     # KL_MOONRAKER, KL_TAILSCALE_USERS
cp klipper-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now klipper-bridge
loginctl enable-linger "$USER"
systemctl --user is-active klipper-bridge
tailscale serve --bg --https=8447 http://127.0.0.1:8898      # nie "serve reset"
tailscale serve status
```

Selbsttest auf dem Rechner (nur von Loopback mit dem Login-Header gültig, wenn du `KL_TAILSCALE_USERS` nutzt):
`curl -s -H "Tailscale-User-Login: dein-login" http://127.0.0.1:8898/api/printer`.

## English

Bridge between Moonraker (LAN-only printer API) and the phone. Code stays in
`apps/klipper-glance/examples/klipper-bridge.mjs`. Set `KL_MOONRAKER` (or let it scan a /24), your Tailscale login
in `KL_TAILSCALE_USERS`, optionally `KL_ALLOW_CONTROL=1`, install the user unit, and publish with
`tailscale serve --bg --https=8447 http://127.0.0.1:8898`.
