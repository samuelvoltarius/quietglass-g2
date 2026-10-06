import type { NewTake, ShootDayApi } from "./client";
import type { CallSheet, EquipmentItem, Shot, Take } from "./types";
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
  };
  const names = de
    ? ["Kamera A", "Kamera B", "Gimbal", "Videostativ", "Richtmikrofon", "Funkstrecke", "Akkus", "Speicherkarten", "Klappe", "Regenschutz"]
    : ["Camera A", "Camera B", "Gimbal", "Tripod", "Shotgun microphone", "Wireless kit", "Batteries", "Memory cards", "Slate", "Rain cover"];
  let items: EquipmentItem[] = names.map((name, i) => ({ group: "", name, need: true, packed: i < 3 }));
  const script = de
    ? "Willkommen zu diesem Beispieltext.\n\nDer Teleprompter rollt den Sprechtext des Projekts ab. Tippen startet und hält an, Wischen ändert das Tempo.\n\nDen echten Text trägst du im Web-Terminal deines Servers ein."
    : "Welcome to this sample script.\n\nThe teleprompter scrolls the project's script. Tap starts and pauses, swipe changes the speed.\n\nYou enter the real text in your server's web terminal.";

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
    prompter: async () => script,
    callSheet: async () => sheet,
    equipment: async () => ({ project: de ? "Beispiel-Dreh" : "Example shoot", items }),
    setPacked: async (name, packed) => { items = items.map((item) => (item.name === name ? { ...item, packed } : item)); },
    // There is no recogniser in the demo: it "hears" one fixed sentence that
    // means something to both the take log and the packing list.
    transcribe: async () => (de ? "Szene 2 A OK, Richtmikrofon eingepackt" : "scene 2 A OK, shotgun microphone packed"),
  };
}
