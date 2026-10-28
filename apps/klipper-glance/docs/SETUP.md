# Klipper Glance einrichten · Setup

*Deutsch zuerst, English below.*

Klipper Glance braucht eine kleine **Bridge**: ein einzelnes Programm
(`klipper-bridge.mjs`), das im Netz deines Druckers läuft, Moonraker fragt und
der Brille einen kompakten Status liefert – auch die **3D-Ansicht** des
laufenden Drucks. Die Brille selbst kann deinen Drucker nicht direkt
erreichen: sie geht über dein Handy, und das ist oft unterwegs.

---

## Deutsch

### Daheim: ohne Bridge (ab 0.6.0)

Ist dein Handy im selben WLAN wie der Drucker, braucht Klipper Glance **nichts
weiter**: Die App liest Moonraker direkt.

1. Even-App → Klipper Glance → Tab **Drucker** → **Drucker suchen** (oder die IP
   eintragen, die Mainsail/Fluidd anzeigt, z. B. `192.168.0.50`) → **Speichern**.
2. Fertig. Pause/Weiter/Abbrechen von der Brille sind aus, bis du dort
   „… von der Brille erlauben“ anhakst.

Antwortet der Drucker nicht: Steht in `moonraker.conf` unter `[authorization]`
eine `trusted_clients`-Liste, muss dein Heimnetz darin stehen (z. B.
`192.168.0.0/16` – bei Mainsail/Fluidd-Installationen ist das Standard).

### Unterwegs: Bridge (optional)

Unterwegs sieht das Handy deinen Drucker nicht. Dafür gibt es die kleine
Bridge, die auf dem Drucker-Pi läuft und über Tailscale per HTTPS erreichbar
ist. **Am schnellsten in einem Befehl** (auf dem Pi, als normaler Nutzer):

```bash
curl -fsSL https://raw.githubusercontent.com/samuelvoltarius/quietglass-g2/main/apps/klipper-glance/examples/install-bridge.sh | bash
```

Das Skript prüft Node.js, legt die Bridge als Dienst an, schaltet sie über
Tailscale frei und zeigt am Ende die Adresse zum Eintragen. Von Hand geht es so:

#### Was du brauchst

- Einen Klipper-Drucker mit **Moonraker** (Mainsail oder Fluidd haben das).
- Einen Rechner, der **immer an** ist und im selben Netz wie der Drucker hängt.
  Am einfachsten: **der Raspberry Pi, auf dem Klipper schon läuft**. Ein NAS,
  Heimserver oder Mini-PC geht genauso.
- **Node.js 18 oder neuer** auf diesem Rechner. Sonst nichts – keine Pakete,
  kein `npm install`.
- **Tailscale** (kostenlos für den Privatgebrauch) auf diesem Rechner und auf
  deinem Handy, damit das Handy die Bridge auch unterwegs über **HTTPS**
  erreicht.

### 1. Bridge holen

Per SSH auf den Pi (oder den Rechner deiner Wahl):

```bash
mkdir -p ~/klipper-glance && cd ~/klipper-glance
curl -fsSLO https://raw.githubusercontent.com/samuelvoltarius/quietglass-g2/main/apps/klipper-glance/examples/klipper-bridge.mjs
node --version    # muss v18 oder höher zeigen
```

Kein Node da? Auf Raspberry Pi OS / Debian: `sudo apt install nodejs`
(zeigt `node --version` danach unter 18, Node von nodejs.org nehmen).

### 2. Ausprobieren

```bash
node klipper-bridge.mjs
```

Die Bridge sucht den Drucker im Netz selbst und meldet, wo sie ihn gefunden
hat. Läuft sie auf dem Drucker-Pi, geht es sofort. Findet sie ihn nicht, gib
ihn fest vor:

```bash
KL_MOONRAKER=http://127.0.0.1:7125 node klipper-bridge.mjs
```

Test in einem zweiten Fenster: `curl http://127.0.0.1:8898/api/printer` –
das liefert den Druckerzustand als JSON. Dann mit Strg+C beenden.

### 3. Als Dienst starten (läuft nach jedem Neustart weiter)

```bash
sudo tee /etc/systemd/system/klipper-glance.service >/dev/null <<EOF
[Unit]
Description=Klipper Glance bridge
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$HOME/klipper-glance
Environment=KL_MOONRAKER=http://127.0.0.1:7125
Environment=KL_TAILSCALE_USERS=deine-tailscale-anmeldung@example.com
ExecStart=/usr/bin/node $HOME/klipper-glance/klipper-bridge.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now klipper-glance
systemctl status klipper-glance --no-pager
```

`KL_TAILSCALE_USERS` = die E-Mail, mit der du bei Tailscale angemeldet bist.
Nur diese Anmeldung kommt dann an die Bridge.

### 4. Vom Handy aus erreichbar machen (HTTPS über Tailscale)

```bash
sudo tailscale serve --bg --https=8898 http://127.0.0.1:8898
tailscale serve status
```

Das zeigt eine Adresse wie `https://drucker-pi.tailXXXX.ts.net:8898`.

### 5. In der App eintragen

Even-App → Klipper Glance → Tab **Verbindung** → die Adresse von Schritt 4
eintragen → speichern. Die Brille zeigt jetzt deinen Drucker statt der Demo.

### Die 3D-Ansicht

Nichts extra einzurichten: auf der Brille im Druckbild **wischen** – die Bridge
holt den G-Code des laufenden Drucks von Moonraker und zeichnet daraus die
Schichten. Der gedruckte Teil leuchtet heller, **Wischen dreht** die Ansicht,
**2×** geht zurück. Bei großen Dateien dauert das erste Laden ein paar
Sekunden. Ohne laufenden Druck gibt es kein Modell.

Das Vorschaubild links im Druckbild kommt aus dem Slicer: in OrcaSlicer,
PrusaSlicer oder SuperSlicer die G-Code-Vorschaubilder (Thumbnails)
einschalten.

### Pause, Weiter, Abbrechen von der Brille (optional)

Aus Sicherheitsgründen standardmäßig **aus**. Einschalten im Dienst mit
`Environment=KL_ALLOW_CONTROL=1` (zusätzlich zu `KL_TAILSCALE_USERS` oder
einem `TOKEN`). Ohne eins der beiden lehnt die Bridge Befehle immer ab. Auf der
Brille braucht jeder Befehl zwei Tipper.

### Getestete Drucker

- Creality K1 (selbst getestet)
- Ender 3 Pro, umgebaut zum Voron Switchwire, mit Mainsail (Nutzerbericht)

Jeder Klipper-Drucker mit Moonraker sollte funktionieren. Berichte zu weiteren
Druckern sind willkommen.

### Wenn's nicht geht

- **Brille zeigt „DEMO“:** Am Handy ist keine Adresse eingetragen.
- **„nicht erreichbar“:** Ist Tailscale am Handy an? Stimmt die Adresse aus
  `tailscale serve status`?
- **Drucker offline, obwohl er läuft:** `KL_MOONRAKER` fest setzen (Schritt 2).
- **„Token falsch oder fehlt“:** Die Tailscale-Anmeldung am Handy muss in
  `KL_TAILSCALE_USERS` stehen.
- Logs: `journalctl -u klipper-glance -f`

---

## English

### At home: no bridge (0.6.0+)

With your phone on the same Wi-Fi as the printer, Klipper Glance needs
**nothing else**: the app reads Moonraker directly.

1. Even app → Klipper Glance → **Printer** tab → **Find printer** (or enter the
   IP that Mainsail/Fluidd shows, e.g. `192.168.0.50`) → **Save**.
2. Done. Pause/resume/cancel from the glasses stay off until you tick
   "… from the glasses" there.

If the printer does not answer: when `moonraker.conf` has a `trusted_clients`
list under `[authorization]`, your home network must be in it (e.g.
`192.168.0.0/16` – the default in Mainsail/Fluidd installs).

### On the go: bridge (optional)

Away from home the phone cannot see your printer. The small bridge runs on the
printer's Pi and is reached over HTTPS through Tailscale. **Quickest, one
command** (on the Pi, as your normal user):

```bash
curl -fsSL https://raw.githubusercontent.com/samuelvoltarius/quietglass-g2/main/apps/klipper-glance/examples/install-bridge.sh | bash
```

The script checks Node.js, installs the bridge as a service, publishes it over
Tailscale and prints the address to enter. By hand:

#### What you need

- A Klipper printer with **Moonraker** (Mainsail and Fluidd ship it).
- A machine that is **always on** and in the printer's network – easiest:
  **the Raspberry Pi that already runs Klipper**; a NAS, home server or mini PC
  works too.
- **Node.js 18 or newer** on it. Nothing else – no packages, no `npm install`.
- **Tailscale** (free for personal use) on that machine and on your phone, so
  the phone reaches the bridge over **HTTPS** even when you are away.

### 1. Get the bridge

```bash
mkdir -p ~/klipper-glance && cd ~/klipper-glance
curl -fsSLO https://raw.githubusercontent.com/samuelvoltarius/quietglass-g2/main/apps/klipper-glance/examples/klipper-bridge.mjs
node --version    # must be v18 or newer
```

### 2. Try it

```bash
node klipper-bridge.mjs                                   # finds the printer itself
KL_MOONRAKER=http://127.0.0.1:7125 node klipper-bridge.mjs # or name it
curl http://127.0.0.1:8898/api/printer                     # in a second shell
```

### 3. Run it as a service

Use the unit from the German section above (same file). Set
`KL_TAILSCALE_USERS` to the email you sign in to Tailscale with – only that
login gets in. Then `sudo systemctl enable --now klipper-glance`.

### 4. Reach it from the phone (HTTPS via Tailscale)

```bash
sudo tailscale serve --bg --https=8898 http://127.0.0.1:8898
tailscale serve status      # shows https://<machine>.<tailnet>.ts.net:8898
```

### 5. Enter it in the app

Even app → Klipper Glance → **Connection** tab → paste the address → save.

### The 3D view

Nothing to set up: **swipe** on the print screen. The bridge fetches the
running print's G-code from Moonraker and draws its layers; the printed part is
brighter, **swipe turns** the view, **2×** goes back. The first load of a large
file takes a few seconds. No print running, no model.

The preview picture comes from the slicer: turn on G-code thumbnails in
OrcaSlicer, PrusaSlicer or SuperSlicer.

### Pause, resume, cancel from the glasses (optional)

**Off** by default. Add `Environment=KL_ALLOW_CONTROL=1` to the service (plus
`KL_TAILSCALE_USERS` or a `TOKEN` – without one of them the bridge refuses
every command). Every command needs two taps on the glasses.

### Tested printers

- Creality K1 (tested by the author)
- Ender 3 Pro rebuilt as a Voron Switchwire, running Mainsail (user report)

Any Klipper printer with Moonraker should work. Reports for other printers are welcome.

### Troubleshooting

- **Glasses show "DEMO":** no address entered on the phone.
- **"unreachable":** Tailscale on the phone on? Address as in `tailscale serve status`?
- **Printer offline although it is on:** set `KL_MOONRAKER` (step 2).
- **"token wrong or missing":** the phone's Tailscale login must be in `KL_TAILSCALE_USERS`.
- Logs: `journalctl -u klipper-glance -f`
