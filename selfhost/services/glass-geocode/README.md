# glass-geocode

Place search for OpenGlance. It speaks like Photon (`/api/?q=`, `/reverse`). It asks Photon and Nominatim
at the same time, takes the first answer with results, and caches it for 24 h. Only behind `tailscale serve`
(header `Tailscale-User-Login`, only from loopback) or with a bearer token. Nominatim: own User-Agent,
at most 1 request/s, search texts are never logged.

```bash
mkdir -p /opt/glass-geocode && cp glass_geocode.py glass-geocode.service /opt/glass-geocode/
cp glass-geocode.env.example /opt/glass-geocode/.env   # enter logins, chmod 600
cp /opt/glass-geocode/glass-geocode.service /etc/systemd/system/ && systemctl enable --now glass-geocode
tailscale serve --bg --https=8479 http://127.0.0.1:8478
```

App: `VITE_GEOCODER_URL=https://<host>.ts.net:8479` and add this origin to the network whitelist of `app.private.json`.
