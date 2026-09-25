#!/usr/bin/env node
/**
 * CORS proxy for LUMEN.
 *
 * Lumen Glass runs as a web app inside the Even app's WebView, so its requests
 * to LUMEN come from a different origin. LUMEN sends no CORS headers, and the
 * browser therefore blocks the response before the app ever sees it — which
 * looks exactly like "LUMEN unreachable" even though the server answered fine.
 *
 * Two ways out:
 *
 *   1. Add CORS to LUMEN itself — three lines, see PATCH.md. Preferred.
 *   2. Run this proxy in front of it and point Lumen Glass here. Changes
 *      nothing in LUMEN.
 *
 *     node lumen-cors-proxy.mjs                    # 127.0.0.1:8078 -> :8077
 *     LUMEN=http://127.0.0.1:8077 PORT=8078 node lumen-cors-proxy.mjs
 *
 * It forwards everything unchanged — including the multipart photo upload and
 * the session cookie — and only adds the headers the browser insists on.
 */
import { createServer } from "node:http";

const LUMEN = (process.env["LUMEN"] ?? "http://127.0.0.1:8077").replace(/\/+$/, "");
const PORT = Number(process.env["PORT"] ?? 8078);
const HOST = process.env["HOST"] ?? "127.0.0.1";

/**
 * Builds the CORS headers for one request.
 *
 * The origin is echoed rather than answered with `*`, because the app sends
 * credentials and the browser rejects a wildcard together with
 * `Allow-Credentials: true`. A wildcard here looks permissive but actually
 * blocks every request the app makes.
 */
function corsFor(request) {
  const origin = request.headers["origin"];
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Cookie",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

  try {
    const target = LUMEN + (request.url ?? "/");

    // Collect the body for anything that carries one. Photos are a few MB, so
    // there is a ceiling — a request larger than this is not a photo.
    const chunks = [];
    let size = 0;
    if (request.method !== "GET" && request.method !== "HEAD") {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) { request.destroy(); return; }
        chunks.push(chunk);
      }
    }

    // Pass the headers through, but drop the ones that describe the hop we
    // just terminated rather than the request itself.
    const headers = { ...request.headers };
    delete headers["host"];
    delete headers["connection"];
    delete headers["content-length"];
    delete headers["origin"];

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
      // LUMEN answers a successful upload with a redirect to a page; the app
      // treats that as success, so it must not be followed here.
      redirect: "manual",
    });

    const out = { ...cors };
    for (const [key, value] of upstream.headers) {
      // Never pass an upstream CORS header through; ours has to win.
      if (key.toLowerCase().startsWith("access-control-")) continue;
      if (key.toLowerCase() === "content-encoding") continue;
      out[key] = value;
    }

    response.writeHead(upstream.status, out);
    const body = Buffer.from(await upstream.arrayBuffer());
    response.end(body);
  } catch (error) {
    console.error("proxy error:", error.message);
    response.writeHead(502, { ...cors, "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "LUMEN unreachable" }));
  }
});

server.listen(PORT, HOST, () => {
  console.log("LUMEN CORS proxy: http://" + HOST + ":" + PORT + "  ->  " + LUMEN);
  console.log("Point Lumen Glass at http://" + HOST + ":" + PORT);
});
