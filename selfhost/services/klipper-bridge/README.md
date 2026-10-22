# klipper-bridge — printer bridge for Klipper Glance

The printer is only on the LAN, but the phone can be anywhere. This bridge runs on a machine that can see the
printer (Raspberry Pi, NAS, server), reads **Moonraker** and gives the phone a compact status. Pause /
resume / cancel are **off** until you set `KL_ALLOW_CONTROL=1`. They are still refused without sign-in
(`KL_TAILSCALE_USERS` or `TOKEN`). **The code is in the repo and is not copied:**
[`apps/klipper-glance/examples/klipper-bridge.mjs`](../../../apps/klipper-glance/examples/klipper-bridge.mjs)
(Node ≥ 18, no dependencies). To test without a printer: `mock-moonraker.mjs` in the same folder.

| Local | Tailscale port (suggestion) | App field / build |
|---|---|---|
| `127.0.0.1:8898` | `8447` | "Bridge address" (Adresse der Brücke) = `https://<your-machine>.<your-tailnet>.ts.net:8447` |

## Install

```bash
git clone https://github.com/samuelvoltarius/quietglass-g2 ~/quietglass-g2     # if not there yet
mkdir -p ~/.config/quietglass ~/.config/systemd/user
cp .env.example ~/.config/quietglass/klipper-bridge.env && chmod 600 ~/.config/quietglass/klipper-bridge.env
$EDITOR ~/.config/quietglass/klipper-bridge.env     # KL_MOONRAKER, KL_TAILSCALE_USERS
cp klipper-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now klipper-bridge
loginctl enable-linger "$USER"
systemctl --user is-active klipper-bridge
tailscale serve --bg --https=8447 http://127.0.0.1:8898      # never "serve reset"
tailscale serve status
```

Self-test on the machine (valid only from loopback with the login header, if you use `KL_TAILSCALE_USERS`):
`curl -s -H "Tailscale-User-Login: your-login" http://127.0.0.1:8898/api/printer`.

If you do not set `KL_MOONRAKER`, the bridge can scan a /24 network for it. Set your Tailscale login in
`KL_TAILSCALE_USERS`, and optionally `KL_ALLOW_CONTROL=1`.
