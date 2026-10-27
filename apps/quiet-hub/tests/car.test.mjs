import { afterEach, describe, expect, it } from "vitest";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionBody, carResult, carStateFrom, createCar, loadIdentity, pair, signUnlock, unlockMessage } from "../examples/quiet-hub-car.mjs";
import { startHub } from "./helpers.mjs";

const URL_ = "http://car.test:8180";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fake Panoptes: pairing request -> allowed on the 2nd poll, key report, actions recorded. Never the real car. */
function fakePanoptes() {
  const seen = [];
  let polls = 0;
  let key = null;
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).slice(URL_.length);
    const body = init.body ? JSON.parse(init.body) : null;
    seen.push({ path, body, auth: init.headers?.Authorization ?? null });
    if (path === "/auth/kopplung/anfrage") return json({ ok: true, id: "a".repeat(32), gueltigBis: 0, abfrageAlleMs: 1 });
    if (path.startsWith("/auth/kopplung/anfrage/")) return json((polls += 1) < 2 ? { status: "wartet" } : { status: "erlaubt", jwt: "jwt-1", kopplungId: "k-quiet", expiresIn: 1 });
    if (path === "/api/handy/v1/geraet") { key = body.oeffentlicherSchluessel; return json({ ok: true }); }
    if (path === "/api/handy/v1/aktion") return json(body.aktion === "klima_an" ? { ok: false, grund: "cloud_nicht_eingerichtet" } : { ok: true, weg: "lokal", bestaetigt: body.aktion !== "klima_aus" });
    if (path === "/api/sitzung/erneuern") return json({ success: true, jwt: "jwt-2", expiresIn: 1 });
    return json({ ok: false }, 404);
  };
  return { fetchImpl, seen, key: () => key };
}

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "qh-car-")), "car.json");

describe("car: Panoptes phone API (fake Panoptes)", () => {
  it("pairs as a phone with a check number and stores key + JWT only in a 600 file", async () => {
    const panoptes = fakePanoptes();
    const file = tmpFile();
    const lines = [];
    const out = await pair({ url: URL_, file, fetchImpl: panoptes.fetchImpl, wait: async () => undefined, print: (l) => lines.push(l) });
    expect(out).toEqual({ kopplungId: "k-quiet", keyReported: true });
    const request = panoptes.seen[0];
    expect(request.path).toBe("/auth/kopplung/anfrage");
    expect(request.body).toMatchObject({ geraet: "Quiet Hub", art: "handy" });
    expect(request.body.pruefzahl).toMatch(/^\d{4}$/);
    expect(lines[0]).toContain(request.body.pruefzahl);
    // Nothing secret is printed.
    expect(lines.join(" ")).not.toMatch(/jwt-1|PRIVATE/);
    const identity = loadIdentity(file);
    expect(identity).toMatchObject({ kopplungId: "k-quiet", jwt: "jwt-1", keyReported: true });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(panoptes.seen.find((s) => s.path === "/api/handy/v1/geraet").auth).toBe("Bearer jwt-1");
    await expect(pair({ url: URL_, file, fetchImpl: panoptes.fetchImpl, wait: async () => undefined, print: () => undefined })).rejects.toThrow(/already paired/);
  });

  it("unlock is signed per request with the Panoptes text, fresh nonce, verifiable with the reported key", async () => {
    const panoptes = fakePanoptes();
    const file = tmpFile();
    await pair({ url: URL_, file, fetchImpl: panoptes.fetchImpl, wait: async () => undefined, print: () => undefined });
    const car = createCar({ url: URL_, file, fetchImpl: panoptes.fetchImpl, now: () => 1_793_000_000_000 });
    expect((await car.action("aufsperren")).result).toEqual({ ok: true, weg: "lokal", bestaetigt: true });
    await car.action("aufsperren");
    const sent = panoptes.seen.filter((s) => s.path === "/api/handy/v1/aktion").map((s) => s.body);
    expect(sent).toHaveLength(2);
    expect(sent[0].signatur.nonce).not.toBe(sent[1].signatur.nonce);
    const publicKey = createPublicKey({ key: Buffer.from(panoptes.key(), "base64"), format: "der", type: "spki" });
    for (const body of sent) {
      expect(body.signatur.zeit).toBe(1_793_000_000_000);
      expect(body.signatur.nonce).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
      const ok = verify("sha256", Buffer.from(unlockMessage("k-quiet", body.signatur.zeit, body.signatur.nonce)), { key: publicKey, dsaEncoding: "der" }, Buffer.from(body.signatur.sig, "base64"));
      expect(ok).toBe(true);
    }
    expect(unlockMessage("k-1", 5, "abcdefgh")).toBe("panoptes-handy-v1|aufsperren|k-1|5|abcdefgh");
  });

  it("only lock, climate on/off and unlock exist; values are checked; answers are passed on honestly", async () => {
    expect(actionBody("hupe")).toBeNull();
    expect(actionBody("licht")).toBeNull();
    expect(actionBody("alarm")).toBeNull();
    expect(actionBody("klima_an", { tempC: 40 })).toBeNull();
    expect(actionBody("klima_an", { tempC: 21, minuten: 15 })).toEqual({ aktion: "klima_an", tempC: 21, minuten: 15 });
    expect(carResult({ ok: true, weg: "cloud", bestaetigt: false, jwt: "x" })).toEqual({ ok: true, weg: "cloud", bestaetigt: false });
    const panoptes = fakePanoptes();
    const file = tmpFile();
    await pair({ url: URL_, file, fetchImpl: panoptes.fetchImpl, wait: async () => undefined, print: () => undefined });
    const car = createCar({ url: URL_, file, fetchImpl: panoptes.fetchImpl });
    expect((await car.action("hupe")).result).toEqual({ ok: false, grund: "aktion" });
    expect((await car.action("klima_an", { tempC: 21, minuten: 15 })).result).toEqual({ ok: false, grund: "cloud_nicht_eingerichtet" });
    expect((await car.action("klima_aus")).result).toEqual({ ok: true, weg: "lokal", bestaetigt: false });
    // No signature on anything but unlock.
    expect(panoptes.seen.filter((s) => s.path === "/api/handy/v1/aktion" && s.body.aktion !== "aufsperren").every((s) => s.body.signatur === undefined)).toBe(true);
  });

  it("renews the session and keeps the new JWT; without pairing nothing is sent", async () => {
    const panoptes = fakePanoptes();
    const file = tmpFile();
    const unpaired = createCar({ url: URL_, file, fetchImpl: panoptes.fetchImpl });
    expect((await unpaired.action("zusperren")).result).toEqual({ ok: false, grund: "nicht_gekoppelt" });
    expect(panoptes.seen).toHaveLength(0);
    // Paired after the daemon started: renew finds the file by itself.
    await pair({ url: URL_, file, fetchImpl: panoptes.fetchImpl, wait: async () => undefined, print: () => undefined });
    const car = unpaired;
    await car.renew();
    expect(loadIdentity(file).jwt).toBe("jwt-2");
    expect(signUnlock(loadIdentity(file).privateKey, "k", 1, "nonce-123").nonce).toBe("nonce-123");
  });
});

describe("car state from Panoptes", () => {
  it("reads the lock from unlocked_lf (0 = locked), battery, range, doors", () => {
    const t = { soc: 57, ev_range_km: 176, is_charging: 0, unlocked_lf: 0, door_open_lf: 0, door_open_rf: 0, power_level: 0, speed: 0, climate_on: 0, ext_temp: 13 };
    expect(carStateFrom({ telemetrie: t, waechter: { zustand: "scharf" } }, 5)).toMatchObject({ status: "ok", soc: 57, rangeKm: 176, locked: true, doorOpen: false, mode: "parked", outsideC: 13, guard: "scharf", at: 5 });
    expect(carStateFrom({ telemetrie: { ...t, unlocked_lf: 1, door_open_rf: 1 } }, 5)).toMatchObject({ locked: false, doorOpen: true });
    expect(carStateFrom({ telemetrie: {} }, 5).locked).toBeNull();
  });
});

describe("daemon /car/action", () => {
  let hub;
  afterEach(async () => { await hub?.close(); hub = undefined; });

  it("is 503 without a car; with one the report says only carControl", async () => {
    hub = await startHub();
    expect((await hub.api("/car/action", { aktion: "zusperren" })).status).toBe(503);
    expect((await hub.api("/report")).json.carControl).toBeUndefined();
    await hub.close();
    const calls = [];
    const car = { configured: () => true, renew: async () => undefined, action: async (aktion, values) => { calls.push({ aktion, values }); return { status: 200, result: { ok: true, weg: "lokal", bestaetigt: true } }; } };
    hub = await startHub({ car });
    const report = (await hub.api("/report")).json;
    expect(report.carControl).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/jwt|privateKey|8180/);
    const done = await hub.api("/car/action", { aktion: "zusperren" });
    expect(done.json).toEqual({ ok: true, weg: "lokal", bestaetigt: true });
    expect(calls).toEqual([{ aktion: "zusperren", values: { tempC: undefined, minuten: undefined } }]);
  });

  it("needs the hub's own auth", async () => {
    hub = await startHub({ car: { configured: () => true, renew: async () => undefined, action: async () => ({ status: 200, result: { ok: true } }) } });
    const res = await fetch(`${hub.url}/car/action`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });
});

