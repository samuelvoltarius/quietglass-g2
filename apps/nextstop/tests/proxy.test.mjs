import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const PROXY = fileURLToPath(new URL("../examples/oebb-cors-proxy.mjs", import.meta.url));

/** A port that was free a moment ago; good enough for a local test. */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

describe("the ÖBB CORS proxy", () => {
  const cleanup = [];
  afterEach(() => { for (const step of cleanup.splice(0)) step(); });

  it("answers 502 when ÖBB stalls instead of holding the request open", async () => {
    // Regression: the upstream fetch had no timeout, so a stalled ÖBB kept
    // every request hanging until the app itself gave up.
    const stalled = createServer(() => { /* never answers */ });
    await new Promise((resolve) => stalled.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => { stalled.closeAllConnections(); stalled.close(); });

    const port = await freePort();
    const proxy = spawn(process.execPath, [PROXY], {
      env: {
        ...process.env, PORT: String(port), HOST: "127.0.0.1",
        UPSTREAM: `http://127.0.0.1:${stalled.address().port}/mgate`, UPSTREAM_TIMEOUT_MS: "300",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanup.push(() => proxy.kill());
    await new Promise((resolve) => proxy.stdout.on("data", (chunk) => { if (String(chunk).includes("proxy")) resolve(); }));

    const response = await fetch(`http://127.0.0.1:${port}/oebb`, {
      method: "POST", body: "{}", signal: AbortSignal.timeout(3000),
    });
    expect(response.status).toBe(502);
  }, 8000);
});
