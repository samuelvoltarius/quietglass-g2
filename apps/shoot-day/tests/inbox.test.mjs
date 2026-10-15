import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { ARTS, TEXT_MAX, clampSure, classifyFile, classifyMessages, parseClassification } from "../examples/shoot-day-inbox.mjs";

// made-up customers and projects only
const candidates = [
  {
    id: "p_000000000001", name: "Imagefilm", customer: "Beispiel Café", date: "2026-10-20",
    tasks: [{ id: 11, title: "Drehvorbereitung" }, { id: 12, title: "Unterlagen" }],
    files: ["Angebot_v1.pdf", "Lageplan.png"], storyboards: ["Reel Sommer"],
  },
  { id: "p_000000000002", name: "Werbespot", customer: "Muster Bäckerei", date: "", tasks: [{ id: 21, title: "Termin: Werbespot" }], files: [], storyboards: [] },
];

describe("inbox classification (shoot-day-inbox.mjs)", () => {
  it("parses the model's answer and keeps only what exists among the candidates", () => {
    const answer = "Hier: ```json\n{\"project\":\"p_000000000001\",\"task\":11,\"art\":\"Storyboard\",\"ersetzt\":\"reel sommer\",\"sicher\":0.82,\"grund\":\"Titel  passt\\n zum Reel.\"}\n```";
    expect(parseClassification(answer, candidates)).toEqual({
      project: "p_000000000001", task: 11, art: "storyboard", ersetzt: "Reel Sommer", sicher: 0.82, grund: "Titel passt zum Reel.",
    });
    // unknown project → everything that hangs on it is null too
    expect(parseClassification("{\"project\":\"p_999999999999\",\"task\":11,\"ersetzt\":\"Reel Sommer\",\"sicher\":0.9,\"art\":\"vertrag\"}", candidates))
      .toMatchObject({ project: null, task: null, ersetzt: null, art: "vertrag", sicher: 0.9 });
    // a task of another project, an unknown name, an unknown kind
    expect(parseClassification("{\"project\":\"p_000000000001\",\"task\":21,\"ersetzt\":\"Vertrag.pdf\",\"art\":\"gedicht\",\"sicher\":1}", candidates))
      .toMatchObject({ project: "p_000000000001", task: null, ersetzt: null, art: "sonstiges", sicher: 1 });
    // task ids may come as strings; a file name without its extension still matches
    expect(parseClassification("{\"project\":\"p_000000000001\",\"task\":\"12\",\"ersetzt\":\"Angebot_v1\",\"sicher\":\"0,7\"}", candidates))
      .toMatchObject({ task: 12, ersetzt: "Angebot_v1.pdf", sicher: 0.7 });
    expect(parseClassification("{\"project\":null,\"task\":null,\"ersetzt\":null}", candidates)).toEqual({ project: null, task: null, art: "sonstiges", ersetzt: null, sicher: 0, grund: "" });
    expect(parseClassification("kein JSON", candidates)).toBeNull();
    expect(parseClassification("[1,2]", candidates)).toBeNull();
    // the project already known: taken whatever the model says
    expect(parseClassification("{\"project\":null,\"art\":\"storyboard\",\"ersetzt\":\"Reel Sommer\"}", candidates, { project: "p_000000000001" }))
      .toMatchObject({ project: "p_000000000001", ersetzt: "Reel Sommer" });
  });

  it("keeps 'sicher' within 0..1 (a percentage is read as one)", () => {
    expect([clampSure(0.5), clampSure(-3), clampSure(85), clampSure("90 %"), clampSure(250), clampSure("viel"), clampSure(null), clampSure(1)])
      .toEqual([0.5, 0, 0.85, 0.9, 1, 0, 0, 1]);
  });

  it("the prompt names every candidate with tasks, files and storyboards, cuts the text, and adds the search hints", () => {
    const [system, user] = classifyMessages({ file: { name: "Reel_v2.pdf", mime: "application/pdf" }, text: "x".repeat(TEXT_MAX + 500), candidates, hints: ["Beispiel Café · Imagefilm (p_000000000001)"] });
    expect(system.content).toContain(ARTS.join("|"));
    expect(user.content).toContain("Datei: Reel_v2.pdf (application/pdf)");
    expect(user.content).toContain("- id: p_000000000001 | Kunde: Beispiel Café | Projekt: Imagefilm | Termin: 2026-10-20");
    expect(user.content).toContain("Offene Aufgaben: [11] Drehvorbereitung; [12] Unterlagen");
    expect(user.content).toContain("Dateien: Angebot_v1.pdf; Lageplan.png");
    expect(user.content).toContain("Storyboards: Reel Sommer");
    expect(user.content).toContain("- id: p_000000000002 | Kunde: Muster Bäckerei");
    expect(user.content).toContain("Ähnlichste Projekte laut Suche");
    expect(user.content).not.toContain("x".repeat(TEXT_MAX + 1));
    // a picture: only its name; a known project: only that one
    const [, image] = classifyMessages({ file: { name: "Set.jpg" }, candidates, project: "p_000000000002" });
    expect(image.content).toContain("(kein Text – Bild oder Scan, nur der Dateiname)");
    expect(image.content).toContain("Das Projekt steht fest: p_000000000002");
    expect(image.content).not.toContain("Imagefilm");
  });

  it("asks the local model and never throws", async () => {
    const llm = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        if (JSON.parse(body).messages[1].content.includes("kaputt")) { response.writeHead(500); response.end(); return; }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: "{\"project\":\"p_000000000002\",\"task\":21,\"art\":\"angebot\",\"sicher\":0.8,\"grund\":\"Bäckerei\"}" } }] }));
      });
    });
    await new Promise((resolve) => llm.listen(0, "127.0.0.1", resolve));
    const url = "http://127.0.0.1:" + llm.address().port + "/v1";
    try {
      expect(await classifyFile({ file: { name: "Angebot.pdf" }, text: "Angebot", candidates }, { url })).toEqual({
        ok: true, result: { project: "p_000000000002", task: 21, art: "angebot", ersetzt: null, sicher: 0.8, grund: "Bäckerei" },
      });
      expect(await classifyFile({ file: { name: "kaputt.pdf" }, candidates }, { url })).toEqual({ ok: false, error: "http 500" });
      expect(await classifyFile({ file: { name: "a.pdf" }, candidates }, { url: "" })).toEqual({ ok: false, error: "not-configured" });
    } finally {
      await new Promise((resolve) => llm.close(resolve));
    }
    expect(await classifyFile({ file: { name: "a.pdf" }, candidates }, { url })).toEqual({ ok: false, error: "unreachable" });
  });
});
