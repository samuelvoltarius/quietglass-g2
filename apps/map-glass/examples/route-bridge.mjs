import http from "node:http";

const osrm = (process.env.OSRM_URL ?? "https://router.project-osrm.org").replace(/\/$/, "");
const labels = {
  de: { left: "Links", right: "Rechts", straight: "Geradeaus", arrive: "Ziel erreicht", onto: "auf" },
  en: { left: "Turn left", right: "Turn right", straight: "Continue", arrive: "Arrive", onto: "onto" },
  fr: { left: "Tournez à gauche", right: "Tournez à droite", straight: "Continuez", arrive: "Arrivée", onto: "sur" },
  es: { left: "Gira a la izquierda", right: "Gira a la derecha", straight: "Continúa", arrive: "Llegada", onto: "en" },
  it: { left: "Svolta a sinistra", right: "Svolta a destra", straight: "Prosegui", arrive: "Arrivo", onto: "su" },
};
function instruction(step, lang) { const text = labels[lang] ?? labels.en; const type = step?.maneuver?.type; const modifier = step?.maneuver?.modifier ?? ""; const action = type === "arrive" ? text.arrive : modifier.includes("left") ? text.left : modifier.includes("right") ? text.right : text.straight; return step?.name ? `${action} ${text.onto} ${step.name}` : action; }
http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1:8791"); const cors = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" };
  if (url.pathname !== "/route") { response.writeHead(404, cors); response.end(JSON.stringify({ error: "not found" })); return; }
  const lat = Number(url.searchParams.get("lat")); const lon = Number(url.searchParams.get("lon")); const destLat = Number(url.searchParams.get("destLat")); const destLon = Number(url.searchParams.get("destLon")); const lang = url.searchParams.get("lang") ?? "en";
  if (![lat, lon, destLat, destLon].every(Number.isFinite)) { response.writeHead(400, cors); response.end(JSON.stringify({ error: "lat, lon, destLat and destLon are required" })); return; }
  try { const target = `${osrm}/route/v1/driving/${lon},${lat};${destLon},${destLat}?overview=full&geometries=geojson&steps=true`; const upstream = await fetch(target, { headers: { "user-agent": "Quietglass-MapGlass/0.1" } }); const data = await upstream.json(); const route = data.routes?.[0]; if (!upstream.ok || !route?.geometry?.coordinates?.length) throw new Error(data.message ?? `OSRM HTTP ${upstream.status}`); const step = route.legs?.[0]?.steps?.find((item) => item.distance > 1) ?? route.legs?.[0]?.steps?.[0]; response.writeHead(200, cors); response.end(JSON.stringify({ instruction: instruction(step, lang), distanceMeters: Math.round(step?.distance ?? route.distance), road: step?.name ?? "", points: route.geometry.coordinates.map(([x, y]) => ({ lat: y, lon: x })) })); } catch (error) { response.writeHead(502, cors); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
}).listen(8791, "127.0.0.1", () => console.log(`Map Glass bridge: http://127.0.0.1:8791/route -> ${osrm}`));
