# Klipper Glance – Ankündigungen (Entwürfe zum Posten)

Posten macht Alfred selbst. Ein Foto der Brillenanzeige während eines Drucks
(z. B. `store/screenshots/glasses-1.png` oder ein Handyfoto durch die Brille) dazu.

---

## Reddit r/klippers (Englisch)

**Title:** I made a Klipper status app for smart glasses (Even G2) – progress, temps and a 3D layer view, no extra software at home

**Body:**

I print a lot while doing other things, so I built **Klipper Glance** for the Even Realities G2 glasses.
It shows file, progress, layer, time left, nozzle and bed temps – and a small 3D view of the
model where the printed part lights up layer by layer. Swipe to turn it.

- **At home it talks to Moonraker directly** – enter your printer's IP (or tap "Find printer"), done.
  No plugin, no extra service.
- On the go there's an optional tiny bridge (Node, one file) that you reach via Tailscale.
  It installs with one command.
- Pause / resume / cancel are **off** until you switch them on, and every command needs two taps.
- Free, open source, no account, no tracking.

Store: Even Hub → "Klipper Glance". Code + setup: https://github.com/samuelvoltarius/quietglass-g2/tree/main/apps/klipper-glance

Tested on a Creality K1 Max with Moonraker. Feedback from Voron/Prusa-Klipper/RatOS folks very welcome –
especially if your printer doesn't show up with "Find printer".

---

## Klipper Discourse – "Showcase" (Englisch)

**Title:** Klipper Glance – print status on Even G2 smart glasses (direct Moonraker, optional bridge)

Short version of the Reddit text. Add: which Moonraker objects are read
(`print_stats`, `display_status`, `virtual_sdcard`, `extruder`, `heater_bed`, `gcode_move`),
that the slicer thumbnail is used for the preview, and that `trusted_clients` must include the
home network (default in Mainsail/Fluidd installs).

---

## Even Realities Discord – #showcase (Englisch, kurz)

Klipper Glance is live in the Even Hub 🖨️ – progress, temps and a 3D layer view of your print.
New in 0.6: at home it reads Moonraker directly, so no bridge needed – just enter the printer IP
or tap "Find printer". Free & open source: https://github.com/samuelvoltarius/quietglass-g2

---

## Deutsch (z. B. Facebook-Gruppe „Klipper Deutschland“, 3D-Druck-Discord)

Ich habe für die Even-G2-Brille eine Klipper-App gebaut: **Klipper Glance** zeigt Fortschritt,
Schicht, Restzeit, Düse und Bett – und eine kleine 3D-Ansicht, in der der gedruckte Teil Schicht für
Schicht aufleuchtet. Daheim spricht sie direkt mit Moonraker: IP eintragen oder „Drucker suchen“,
fertig. Unterwegs gibt es optional eine kleine Bridge über Tailscale (Installation mit einem Befehl).
Pause/Abbruch sind aus, bis man sie einschaltet. Kostenlos, Open Source, kein Konto.
Im Even Hub: „Klipper Glance“.
