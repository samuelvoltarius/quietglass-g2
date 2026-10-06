#!/usr/bin/env node
/**
 * CORS proxy for ÖBB.
 *
 * NextStop runs as a web app inside the Even app's WebView, so its requests to
 * ÖBB come from a different origin. ÖBB's timetable service sends no CORS
 * headers — it was never meant to be called from a third-party web page — and
 * the browser therefore discards the response before the app ever sees it.
 *
 * The symptom is misleading: the glasses show "ÖBB nicht erreichbar" while the
 * very same request from a terminal works perfectly. The server answered; the
 * browser threw the answer away.
 *
 *     node oebb-cors-proxy.mjs                  # 127.0.0.1:8079
 *     PORT=8079 HOST=0.0.0.0 node oebb-cors-proxy.mjs
 *
 * Then point NextStop at http://127.0.0.1:8079/oebb in the phone app.
 *
 * Note on what this talks to: fahrplan.oebb.at/bin/mgate.exe is the endpoint
 * ÖBB's own apps use, not a published open-data API. It needs no key and no
 * account, but nobody has promised it will keep its shape. If it changes,
 * NextStop degrades to showing timetable times rather than failing outright —
 * and Transitous remains available as the other backend.
 */
import { createServer } from "node:http";

const UPSTREAM = process.env["UPSTREAM"] ?? "https://fahrplan.oebb.at/bin/mgate.exe";
/**
 * How long ÖBB gets to answer. Without a limit a stalled upstream held every
 * request open until the app's own 12 s timeout gave up, with no 502 to say
 * which side failed.
 */
const UPSTREAM_TIMEOUT_MS = Number(process.env["UPSTREAM_TIMEOUT_MS"] ?? 10000);
const PORT = Number(process.env["PORT"] ?? 8079);
const HOST = process.env["HOST"] ?? "127.0.0.1";

/** Requests larger than this are not timetable queries. */
const MAX_BODY = 256 * 1024;

/**
 * The origin is echoed rather than answered with `*`.
 *
 * A wildcard looks like the permissive choice and is in fact the one that
 * blocks everything the moment credentials are involved — the specification
 * forbids combining them. Echoing costs nothing and never has that failure.
 */
function corsFor(request) {
  const origin = request.headers["origin"];
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const server = createServer(async (request, response) => {
  const cors = corsFor(request);

  if (request.method === "OPTIONS") {
    response.writeHead(204, cors);
    response.end();
    return;
  }

  // Only the one path, and only POST. A proxy that forwards anything anywhere
  // is an open relay sitting on the user's network.
  const path = (request.url ?? "/").split("?")[0];
  if (path !== "/oebb" || request.method !== "POST") {
    response.writeHead(404, { ...cors, "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "POST /oebb" }));
    return;
  }

  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY) { request.destroy(); return; }
      chunks.push(chunk);
    }

    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // ÖBB's service is picky about anonymous clients; the app's own
        // agent is what its mobile apps send.
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
      },
      body: Buffer.concat(chunks),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    const body = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      ...cors,
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    });
    response.end(body);
  } catch (error) {
    console.error("proxy error:", error.message);
    response.writeHead(502, { ...cors, "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "ÖBB nicht erreichbar" }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ÖBB CORS proxy: http://${HOST}:${PORT}/oebb  ->  ${UPSTREAM}`);
  console.log(`Trage in der Handy-App http://${HOST}:${PORT}/oebb ein.`);
});
