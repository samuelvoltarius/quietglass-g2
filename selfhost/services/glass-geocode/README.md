# glass-geocode

Ortssuche für OpenGlance, spricht wie Photon (`/api/?q=`, `/reverse`). Fragt Photon und Nominatim
gleichzeitig, nimmt die erste Antwort mit Treffern, merkt sie sich 24 h. Nur hinter `tailscale serve`
(Header `Tailscale-User-Login`, nur von Loopback) oder mit Bearer-Token. Nominatim: eigener User-Agent,
höchstens 1 Anfrage/s, Suchtexte werden nie geloggt.

```bash
mkdir -p /opt/glass-geocode && cp glass_geocode.py glass-geocode.service /opt/glass-geocode/
cp glass-geocode.env.example /opt/glass-geocode/.env   # Logins eintragen, chmod 600
cp /opt/glass-geocode/glass-geocode.service /etc/systemd/system/ && systemctl enable --now glass-geocode
tailscale serve --bg --https=8479 http://127.0.0.1:8478
```

App: `VITE_GEOCODER_URL=https://<host>.ts.net:8479` und diesen Origin in die Netzwerk-Freigabe von `app.private.json`.
