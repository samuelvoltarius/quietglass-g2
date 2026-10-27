import { describe, expect, it } from "vitest";

/**
 * Store rule (Even Hub review 21.10.2026): no URL-looking string may be in the
 * bundle unless it matches an exact whitelisted origin - and TV Glance has
 * none, because every address is typed by the user. This checks the sources
 * (what ends up in the bundle) with the same patterns as
 * tools/check-store-urls.mjs, which checks the built dist/ as well.
 */
const node = (globalThis as unknown as { process: { cwd(): string } }).process;

async function sources(): Promise<{ file: string; text: string }[]> {
  const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as unknown as {
    readdirSync(path: string, options: { recursive: boolean }): string[];
    readFileSync(path: string, encoding: string): string;
  };
  const root = node.cwd();
  const files = fs.readdirSync(`${root}/src`, { recursive: true }).map(String).filter((name) => /\.(ts|css)$/.test(name));
  return [...files.map((name) => `src/${name.replace(/\\/g, "/")}`), "index.html"].map((file) => ({ file, text: fs.readFileSync(`${root}/${file}`, "utf8") }));
}

describe("no URL literals in the bundle sources", () => {
  it("no scheme-and-host URL anywhere in src/ or index.html", async () => {
    const found: string[] = [];
    for (const { file, text } of await sources()) {
      for (const match of text.matchAll(/(?:https?|wss?):\/\/[^\s"'`<>)\\]+/gi)) found.push(`${file}: ${match[0]}`);
    }
    expect(found).toEqual([]);
  });

  it("no bare scheme closed by a quote (a URL built at runtime or a placeholder)", async () => {
    const found: string[] = [];
    for (const { file, text } of await sources()) {
      for (const match of text.matchAll(/(?:https?|wss?):\/\/["'`]/gi)) found.push(`${file}: ${match[0]}`);
    }
    expect(found).toEqual([]);
  });

  it("the network whitelist holds only the wildcards for user-entered addresses", async () => {
    const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as unknown as { readFileSync(path: string, encoding: string): string };
    const manifest = JSON.parse(fs.readFileSync(`${node.cwd()}/app.json`, "utf8")) as { package_id: string; version: string; permissions: { name: string; desc: string; whitelist?: string[] }[] };
    expect(manifest.package_id).toBe("glass.quiet.tvglance");
    const network = manifest.permissions.find((p) => p.name === "network");
    expect(network?.whitelist).toEqual(["http://*", "https://*"]);
    for (const permission of manifest.permissions) expect(permission.desc.length).toBeLessThanOrEqual(300);
    const pkg = JSON.parse(fs.readFileSync(`${node.cwd()}/package.json`, "utf8")) as { version: string };
    const main = fs.readFileSync(`${node.cwd()}/src/main.ts`, "utf8");
    expect(pkg.version).toBe(manifest.version);
    expect(main).toContain(`BUILD = "${manifest.version}"`);
  });
});
