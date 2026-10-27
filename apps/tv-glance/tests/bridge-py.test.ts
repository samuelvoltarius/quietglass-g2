import { describe, expect, it } from "vitest";

/**
 * The reference bridge's own self-test (fake TV, loopback only, no
 * androidtvremote2 needed). Skipped where no Python is installed.
 */
const node = (globalThis as unknown as { process: { cwd(): string } }).process;
type Spawn = (cmd: string, args: string[], options: { encoding: string; timeout: number; cwd: string }) => { status: number | null; stdout: string; error?: Error };

async function spawn(): Promise<Spawn> {
  return ((await import(/* @vite-ignore */ "node:" + "child_process")) as unknown as { spawnSync: Spawn }).spawnSync;
}

describe("androidtv-bridge.py --selftest", () => {
  it("passes with the fake TV", async () => {
    const run = await spawn();
    let python = "";
    for (const candidate of ["python3", "python"]) {
      const probe = run(candidate, ["--version"], { encoding: "utf8", timeout: 10_000, cwd: node.cwd() });
      if (!probe.error && probe.status === 0) { python = candidate; break; }
    }
    if (!python) return; // no Python on this machine
    const result = run(python, ["examples/androidtv-bridge.py", "--selftest"], { encoding: "utf8", timeout: 60_000, cwd: node.cwd() });
    expect(result.stdout).toContain("selftest ok");
    expect(result.status).toBe(0);
  }, 70_000);
});
