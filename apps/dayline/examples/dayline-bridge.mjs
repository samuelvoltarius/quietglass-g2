import http from "node:http";
let items = [
  { id: "demo-1", at: new Date(Date.now() + 45 * 60_000).toISOString(), title: "Team-Check-in", kind: "event" },
  { id: "demo-2", at: new Date(Date.now() + 120 * 60_000).toISOString(), title: "Angebot senden", kind: "reminder" },
];
const headers = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type", "content-type": "application/json; charset=utf-8" };
http.createServer((request, response) => {
  if (request.method === "OPTIONS") { response.writeHead(204, headers); response.end(); return; }
  if (request.url !== "/items") { response.writeHead(404, headers); response.end(JSON.stringify({ error: "not found" })); return; }
  if (request.method === "GET") { response.writeHead(200, headers); response.end(JSON.stringify(items)); return; }
  if (request.method === "POST") { const chunks = []; request.on("data", (chunk) => chunks.push(chunk)); request.on("end", () => { try { const next = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (Array.isArray(next)) items = next; else items.push(next); response.writeHead(204, headers); response.end(); } catch { response.writeHead(400, headers); response.end(JSON.stringify({ error: "invalid JSON" })); } }); return; }
  response.writeHead(405, headers); response.end(JSON.stringify({ error: "method not allowed" }));
}).listen(8788, "127.0.0.1", () => console.log("Dayline bridge: http://127.0.0.1:8788/items"));
