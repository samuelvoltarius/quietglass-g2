import type { NewTake, ShootDayApi } from "./client";
import type { BoardScene, CallSheet, CustomerItem, EquipmentItem, ProjectItem, Shot, Storyboard, Take } from "./types";
import type { Locale } from "../i18n";

/**
 * In-memory stand-in for the server, used only by `?demo=1` (screenshots and
 * the simulator). Everything it shows is labelled DEMO on the glasses, and
 * nothing it does is stored.
 */
export function createDemoApi(locale: Locale, now: () => Date = () => new Date()): ShootDayApi {
  const de = locale === "de";
  const shots: Shot[] = de
    ? [
      { scene: "1", shot: "A", desc: "Totale: Ankunft am Haus", size: "WS" },
      { scene: "1", shot: "B", desc: "Nah: Gesicht beim Klingeln", size: "CU" },
      { scene: "2", shot: "A", desc: "Dialog in der Küche, Zweier", size: "MS" },
      { scene: "2", shot: "B", desc: "Über die Schulter, rechts", size: "MCU" },
      { scene: "3", shot: "A", desc: "Insert: Hände am Tisch", size: "ECU" },
    ]
    : [
      { scene: "1", shot: "A", desc: "Wide: arriving at the house", size: "WS" },
      { scene: "1", shot: "B", desc: "Close: face at the door bell", size: "CU" },
      { scene: "2", shot: "A", desc: "Kitchen dialogue, two-shot", size: "MS" },
      { scene: "2", shot: "B", desc: "Over the shoulder, right", size: "MCU" },
      { scene: "3", shot: "A", desc: "Insert: hands on the table", size: "ECU" },
    ];
  const base = now().getTime();
  const takes: Take[] = [
    { scene: "1", shot: "A", n: 1, status: "NG", note: de ? "Ton" : "sound", ts: base - 50 * 60_000 },
    { scene: "1", shot: "A", n: 2, status: "OK", note: "", ts: base - 42 * 60_000 },
  ];
  const clock = (offsetMinutes: number): string => {
    const at = new Date(base + offsetMinutes * 60_000);
    return String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0");
  };
  const sheet: CallSheet = {
    date: de ? "heute" : "today",
    call: clock(-120),
    location: de ? "Beispielstraße 1" : "1 Example Street",
    contact: de ? "Aufnahmeleitung" : "Location manager",
    notes: "",
    schedule: [
      { time: clock(-120), what: de ? "Ankunft, Aufbau" : "Arrival, set-up" },
      { time: clock(-30), what: de ? "Szene 1" : "Scene 1" },
      { time: clock(25), what: de ? "Szene 2, Küche" : "Scene 2, kitchen" },
      { time: clock(90), what: de ? "Mittagspause" : "Lunch" },
      { time: clock(150), what: de ? "Szene 3" : "Scene 3" },
      { time: clock(240), what: de ? "Abbau" : "Wrap" },
    ],
    // A sample place (Salzburg's old town) so the light view has something to show.
    latitude: 47.8,
    longitude: 13.04,
  };
  const names = de
    ? ["Kamera A", "Kamera B", "Gimbal", "Videostativ", "Richtmikrofon", "Funkstrecke", "Akkus", "Speicherkarten", "Klappe", "Regenschutz"]
    : ["Camera A", "Camera B", "Gimbal", "Tripod", "Shotgun microphone", "Wireless kit", "Batteries", "Memory cards", "Slate", "Rain cover"];
  let items: EquipmentItem[] = names.map((name, i) => ({ group: "", name, need: true, packed: i < 3 }));
  const script = de
    ? "Willkommen zu diesem Beispieltext.\n\nDer Teleprompter rollt den Sprechtext des Projekts ab. Tippen startet und hält an, Wischen ändert das Tempo.\n\nDen echten Text trägst du im Web-Terminal deines Servers ein."
    : "Welcome to this sample script.\n\nThe teleprompter scrolls the project's script. Tap starts and pauses, swipe changes the speed.\n\nYou enter the real text in your server's web terminal.";

  // Invented customers: nothing here belongs to anybody.
  let customers: CustomerItem[] = de
    ? [
      { id: "c_000000000001", name: "Anna Beispiel", company: "", projectCount: 1 },
      { id: "c_000000000002", name: "Bäckerei Sonnenschein", company: "Sonnenschein KG", projectCount: 2 },
      { id: "c_000000000003", name: "Studio Nordlicht", company: "", projectCount: 0 },
    ]
    : [
      { id: "c_000000000001", name: "Anna Example", company: "", projectCount: 1 },
      { id: "c_000000000002", name: "Sunshine Bakery", company: "Sunshine Ltd", projectCount: 2 },
      { id: "c_000000000003", name: "Studio Northlight", company: "", projectCount: 0 },
    ];
  const projects: Record<string, ProjectItem[]> = {
    c_000000000001: [{ id: "p_000000000001", name: de ? "Porträt im Park" : "Portrait in the park", date: "2026-10-20", place: "" }],
    c_000000000002: [
      { id: "p_000000000002", name: de ? "Beispiel-Dreh" : "Example shoot", date: "2026-10-14", place: de ? "Backstube" : "Bakehouse" },
      { id: "p_000000000003", name: de ? "Reel Frühstück" : "Breakfast reel", date: "", place: "" },
    ],
  };
  let active = "p_000000000002";
  const scenes: BoardScene[] = (de
    ? [
      ["Ankunft am Morgen", "Die Tür geht auf, Licht fällt in die Backstube.", "Totale vom Stativ, leicht von unten", "Frisch seit 5 Uhr", "Neugier wecken"],
      ["Hände im Teig", "Nahaufnahme: Hände kneten den Teig.", "Nah, langsamer Schwenk nach rechts", "", "Handwerk zeigen"],
      ["Aus dem Ofen", "Das Blech kommt aus dem Ofen, Dampf steigt auf.", "Halbnah, Gegenlicht", "Ofenfrisch", "Appetit machen"],
      ["Erster Kunde", "Lächeln an der Theke, Tüte wird übergeben.", "Über die Schulter, Gimbal", "Bis morgen!", "Zum Besuch einladen"],
    ]
    : [
      ["Morning arrival", "The door opens, light falls into the bakehouse.", "Wide on the tripod, slightly low", "Fresh since 5 am", "Spark curiosity"],
      ["Hands in the dough", "Close-up: hands knead the dough.", "Close, slow pan to the right", "", "Show the craft"],
      ["Out of the oven", "The tray comes out, steam rises.", "Medium, back light", "Straight from the oven", "Make people hungry"],
      ["First customer", "A smile at the counter, a bag is handed over.", "Over the shoulder, gimbal", "See you tomorrow!", "Invite a visit"],
    ]).map(([title, content, camera, overlay, goal], i) => ({
    n: i + 1, from: i * 5, to: i * 5 + 5, title: title ?? "", content: content ?? "", camera: camera ?? "", overlay: overlay ?? "", goal: goal ?? "", done: i === 0,
  }));
  let boards: Storyboard[] = [{ id: "s_000000000001", title: de ? "Reel Backstube" : "Bakehouse reel", scenes }];

  return {
    demo: true,
    shotList: async () => ({ project: de ? "Beispiel-Dreh" : "Example shoot", shots }),
    takes: async () => [...takes],
    addTake: async (take: NewTake) => {
      const n = takes.filter((t) => t.scene === take.scene && t.shot === take.shot).length + 1;
      const saved: Take = { ...take, n, ts: Date.now() };
      takes.push(saved);
      return saved;
    },
    setTakeNote: async (scene, shot, n, note) => {
      const index = takes.findIndex((t) => t.scene === scene && t.shot === shot && t.n === n);
      const found = takes[index];
      if (found) takes[index] = { ...found, note };
    },
    deleteTake: async (scene, shot, n) => {
      const index = takes.findIndex((t) => t.scene === scene && t.shot === shot && t.n === n);
      if (index >= 0) takes.splice(index, 1);
    },
    prompter: async () => script,
    callSheet: async () => sheet,
    equipment: async () => ({ project: de ? "Beispiel-Dreh" : "Example shoot", items }),
    setPacked: async (name, packed) => { items = items.map((item) => (item.name === name ? { ...item, packed } : item)); },
    // There is no recogniser in the demo: it "hears" one fixed sentence that
    // means something to both the take log and the packing list.
    transcribe: async () => (de ? "Szene 2 A OK, Richtmikrofon eingepackt" : "scene 2 A OK, shotgun microphone packed"),
    customers: async () => ({
      customers: [...customers],
      activeProject: active,
      activeCustomer: Object.entries(projects).find(([, list]) => list.some((p) => p.id === active))?.[0] ?? "",
    }),
    customer: async (id) => {
      const customer = customers.find((c) => c.id === id);
      if (!customer) throw new Error("unknown customer");
      return { customer, projects: projects[id] ?? [] };
    },
    createCustomer: async (name) => {
      const created: CustomerItem = { id: "c_" + String(customers.length + 1).padStart(12, "0"), name, company: "", projectCount: 0 };
      customers = [...customers, created].sort((a, b) => a.name.localeCompare(b.name, locale));
      return created;
    },
    brief: async (id) => {
      const customer = customers.find((c) => c.id === id);
      return {
        id, name: customer?.name ?? "", company: customer?.company ?? "", phone: "+43 000 000000", email: "",
        notes: de ? "Mag ruhige Bilder, keine schnellen Schnitte. Kaffee schwarz." : "Likes calm pictures, no fast cuts. Coffee black.",
        updated: base - 2 * 86_400_000,
        ideas: [{ text: de ? "Drohnenflug über den Hof bei Sonnenaufgang" : "Drone shot over the yard at sunrise", tags: ["drohne"], project: "" }],
        memory: null,
        memoryError: false,
      };
    },
    activate: async (projectId) => { active = projectId; },
    storyboards: async () => boards,
    setSceneDone: async (storyboardId, index, done) => {
      boards = boards.map((b) => (b.id !== storyboardId ? b : { ...b, scenes: b.scenes.map((s, i) => (i === index ? { ...s, done } : s)) }));
    },
  };
}
