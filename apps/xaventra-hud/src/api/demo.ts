import { ApiError, type XaventraApi } from "./client";
import type { Answer, HudCard, HudFeed } from "./types";
import type { Locale } from "../i18n";

/**
 * Sample data for `?demo=1`: one outward-acting card so the confirming second
 * tap can be tried, plus a voice reply. Nothing leaves the device.
 */
export function createDemoApi(locale: Locale, scene: string | null = null): XaventraApi {
  const de = locale === "de";
  const card: HudCard = {
    id: "demo-1",
    title: de ? "Drucker starten?" : "Start the printer?",
    text: de ? "Der Testdruck ist bereit. Jetzt auf dem Drucker starten?" : "The test print is ready. Start it on the printer now?",
    effect: de ? "physisch" : "physical",
  };
  // `?demo=1&scene=` shows the other faces: idle, working, error (server problem), offline.
  let cards: HudCard[] = scene === "idle" || scene === "working" || scene === "error" || scene === "offline" ? [] : [card];
  const status = scene === "idle"
    ? (de ? "Alles ruhig" : "All quiet")
    : de ? "Prüft Drucker — Schritt 1/2" : "Checking printer — step 1/2";
  const feed = (): HudFeed => {
    if (scene === "error") throw new ApiError("auth", 401);
    if (scene === "offline") throw new ApiError("unreachable");
    return { version: "demo-" + cards.length, status, cards };
  };
  const reply = (transcript: string) => ({
    transcript,
    action: "message" as const,
    cardId: "",
    reply: de ? "Der Drucker prüft gerade die Düse. Danach wartet eine Frage auf dich." : "The printer is checking the nozzle. A question for you follows.",
  });
  return {
    demo: true,
    feed: (since, signal) => new Promise((resolve, reject) => {
      let current: HudFeed;
      try { current = feed(); } catch (error) { reject(error); return; }
      if (current.version !== since) { resolve(current); return; }
      const timer = setTimeout(() => resolve(feed()), 20_000);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); }, { once: true });
    }),
    answer: async (cardId: string, _answer: Answer) => {
      cards = cards.filter((entry) => entry.id !== cardId);
      return { message: de ? "Erledigt." : "Done." };
    },
    voice: async () => reply(de ? "Wie ist der Stand?" : "What is the status?"),
    ask: async (text: string) => reply(text),
  };
}
