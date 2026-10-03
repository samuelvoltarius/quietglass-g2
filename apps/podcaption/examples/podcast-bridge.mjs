import http from "node:http";
const feedUrl = process.env.PODCAST_FEED_URL ?? ""; let allowedTranscripts = new Set();
const cors = { "access-control-allow-origin": "*", "content-type": "text/plain; charset=utf-8" };
async function proxy(url, response, remember = false) { try { const upstream = await fetch(url, { headers: { "user-agent": "Quietglass-PodCaption/0.1" } }); const body = await upstream.text(); if (remember) allowedTranscripts = new Set([...body.matchAll(/<podcast:transcript\b[^>]*\burl=["']([^"']+)["']/gi)].map((match) => match[1])); response.writeHead(upstream.status, { ...cors, "content-type": upstream.headers.get("content-type") ?? cors["content-type"] }); response.end(body); } catch (error) { response.writeHead(502, cors); response.end(error instanceof Error ? error.message : String(error)); } }
http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1:8789");
  if (url.pathname === "/feed") { if (!feedUrl) { response.writeHead(503, cors); response.end("Set PODCAST_FEED_URL before starting the bridge."); return; } void proxy(feedUrl, response, true); return; }
  if (url.pathname === "/transcript") { const target = url.searchParams.get("url") ?? ""; if (!allowedTranscripts.has(target)) { response.writeHead(403, cors); response.end("Transcript URL was not present in the configured feed."); return; } void proxy(target, response); return; }
  response.writeHead(404, cors); response.end("not found");
}).listen(8789, "127.0.0.1", () => console.log("PodCaption bridge: http://127.0.0.1:8789"));
