import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { appStore } from "./storage/kv";
import { createExitRequest } from "./exit";
import { createTextPage, updateTextPage, type MenuSpec, type TextView } from "./glasses/text";
import { helpView, liveView, qis, SPORT_CHOICES, sportListView } from "./glasses/views";
import { languageSelect, rememberLocale, resolveLocale, setLocale, type Locale } from "./i18n";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { demoTelemetry, effectiveSport, fetchTelemetry, nextSport, pace, paceOf, parseTimestamp, speedOf, staleAge, type Sport } from "./telemetry/model";
import { escapeHtml } from "./ui/html";
import { VERSION } from "./version";
import { words } from "./words";
const DEFAULT_ENDPOINT = "http://127.0.0.1:8792/live";
const RUN_ICON = ["....##....", "...####...", "....##....", "...####...", "..######..", "....##....", "...###....", "..##.##...", ".##...##..", "##.....##."] as const;
const BIKE_ICON = [".....##.....", "....####....", ".....##.....", "...######...", "..##..###...", ".##..##.###.", "##..##....##", "##...######.", ".##.......##", "..###...###.", "....#####..."] as const;

/** Phone tabs in the QIS v1 order: content, Brille, Verbindung, Mehr. */
const TABS = ["live", "glasses", "bridge", "more"] as const;
/** Side menu entries of the glasses (QIS v1.2): ids are never 0. */
const MENU = { sport: 1, help: 2 } as const;
/**
 * The glasses' side menu (QIS v1.2). Off: measured with the step log on the real glasses (15.10.2026), the menu is
 * shown but its clicks never reach the app, and while a page carries a menu a hold opens it instead of reaching the app.
 * Off, the pages carry no menu and swipe / hold do what the menu entries did.
 */
const SIDE_MENU = false;
type Tab = (typeof TABS)[number];

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();
  // SDK KV is the durable store; hydrate before anything reads a value.
  await appStore.init(bridge, ["quietglass.locale", "endurance.sport", "endurance.endpoint", "endurance.invert", "endurance.tab"]);
  let locale = await resolveLocale(bridge);
  setLocale(locale);
  let data = demoTelemetry();
  let receivedAt = Date.now();
  let failed = false;
  let lastError = "";
  let choice = appStore.get("endurance.sport");
  let pageReady = false;
  let last = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let closed = false;
  let screen: "live" | "help" | "sport" = "live";
  let sportCursor = 0;
  let tab: Tab = TABS.find((id) => id === appStore.get("endurance.tab")) ?? "live";
  const t = () => words[locale];
  const invertScroll = (): boolean => appStore.get("endurance.invert") === "1";
  const sport = (): Sport => effectiveSport(choice, data.sport);
  // Demo data stays DEMO; live data turns "STALE 12s" once the watch stops posting (old updatedAt) or the bridge stops answering.
  const mode = (): string => {
    if (data.source === "demo") return t().demo;
    const age = staleAge(parseTimestamp(data.updatedAt) ?? receivedAt, Date.now(), failed);
    return age ? `${t().stale} ${age}` : t().live;
  };
  const menu = (): MenuSpec => ({ items: !SIDE_MENU ? [] : [{ id: MENU.sport, label: qis[locale].menuSport }, { id: MENU.help, label: qis[locale].menuHelp }] });
  const view = (): TextView => (screen === "help" ? helpView(locale) : screen === "sport" ? sportListView(locale, sportCursor, choice === "run" || choice === "bike" ? choice : null) : liveView(locale, mode(), sport(), data));
  const draw = async (): Promise<void> => {
    if (closed) return;
    const next = view();
    const sig = JSON.stringify(next) + sport();
    if (sig === last) return;
    const icon = sport() === "run" ? RUN_ICON : BIKE_ICON;
    pageReady = pageReady ? await updateTextPage(bridge, next, icon) : await createTextPage(bridge, next, icon, menu());
    // A failed write leaves the glasses in an unknown state: forget what was last shown so the next draw rewrites it.
    last = pageReady ? sig : "";
  };
  // The phone page is rebuilt on every poll; skip that while the rider is typing so the endpoint field is not wiped every 2 s.
  const phoneIdle = (): boolean => !document.activeElement?.matches("#app input, #app select");
  const refresh = async (): Promise<void> => {
    if (polling || closed) return;
    polling = true;
    try {
      data = await fetchTelemetry(appStore.get("endurance.endpoint") || DEFAULT_ENDPOINT);
      receivedAt = Date.now();
      failed = false;
      lastError = "";
    } catch (error) {
      console.warn("[endurance-hud] bridge unavailable", error);
      failed = true;
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      polling = false;
    }
    await draw();
    if (phoneIdle()) renderPhone();
  };
  const setSport = (value: string | null): void => {
    choice = value === "run" || value === "bike" ? value : null;
    if (choice) appStore.set("endurance.sport", choice);
    else appStore.remove("endurance.sport");
    void draw();
    if (phoneIdle()) renderPhone();
  };
  const tabContent = (): string => {
    const q = qis[locale];
    if (tab === "glasses") {
      const options = [["", t().auto], ["bike", t().bike], ["run", t().run]]
        .map(([value, name]) => `<option value="${value}"${(choice ?? "") === value ? " selected" : ""}>${name}</option>`)
        .join("");
      return `<section class="card">${languageSelect(locale)}<label>${t().sport}<select id="sport">${options}</select></label><label class="check"><input id="invert" type="checkbox"${invertScroll() ? " checked" : ""}> ${q.invert}</label><p class="hint">${q.invertHint}</p></section>`;
    }
    if (tab === "bridge") {
      return `<section class="card"><label>${t().endpoint}<input id="endpoint" type="text" value="${escapeHtml(appStore.get("endurance.endpoint") || DEFAULT_ENDPOINT)}"></label><button id="save">${t().save}</button><p class="hint">${t().help}</p></section>`;
    }
    if (tab === "more") {
      return `<section class="card"><p><strong>Endurance HUD</strong> · ${q.moreVersion} ${VERSION}</p><p class="hint">${q.morePrivacy}</p></section>`;
    }
    const run = sport() === "run";
    const warn = mode() !== t().live;
    return `<section class="card"><div class="status-row"><span class="status-dot ${warn ? "warn" : ""}"></span><strong>${escapeHtml(mode())}</strong></div>${lastError ? `<p class="error">${t().error}: ${escapeHtml(lastError)}</p>` : ""}<div class="metrics"><div><b>${run ? pace(paceOf(data)) : speedOf(data).toFixed(1)}</b><span>${run ? `${t().pace} /km` : `${t().speed} km/h`}</span></div><div><b>${Math.round(data.powerWatts)}</b><span>${t().power} W</span></div><div><b>${Math.round(data.heartRate)}</b><span>${t().heart} bpm</span></div><div><b>${Math.round(data.cadence)}</b><span>${t().cadence} rpm</span></div></div></section>`;
  };
  const renderPhone = (): void => {
    const app = document.querySelector<HTMLDivElement>("#app");
    if (!app) return;
    const q = qis[locale];
    const names: Record<Tab, string> = { live: q.tabLive, glasses: q.tabGlasses, bridge: q.tabBridge, more: q.tabMore };
    const bar = TABS.map((id) => `<button type="button" role="tab" id="tab-${id}"${id === tab ? ' class="on" aria-selected="true"' : ""}>${names[id]}</button>`).join("");
    app.innerHTML = `<header class="brand"><div class="brand-mark">QUIETGLASS / SPORT</div><h1>Endurance HUD</h1><p class="lede">${t().lede}</p></header>${tabContent()}<nav class="tabbar" role="tablist">${bar}</nav>`;
    for (const id of TABS) {
      document.querySelector(`#tab-${id}`)?.addEventListener("click", () => { tab = id; appStore.set("endurance.tab", id); renderPhone(); });
    }
    document.querySelector("#language")?.addEventListener("change", (event) => {
      locale = (event.target as HTMLSelectElement).value as Locale;
      rememberLocale(bridge, locale);
      pageReady = false; // the side menu is part of the page: rebuilt in the new language (if it has one)
      last = "";
      void draw();
      renderPhone();
    });
    document.querySelector("#sport")?.addEventListener("change", (event) => setSport((event.target as HTMLSelectElement).value));
    document.querySelector("#invert")?.addEventListener("change", (event) => { appStore.set("endurance.invert", (event.target as HTMLInputElement).checked ? "1" : "0"); });
    document.querySelector("#save")?.addEventListener("click", () => {
      const input = document.querySelector<HTMLInputElement>("#endpoint");
      if (input) appStore.set("endurance.endpoint", input.value.trim());
      void refresh();
    });
  };
  // QIS v1.2: tap reloads; with SIDE_MENU on, the glasses' side menu (hold) holds Hilfe and Sportart. The sport is chosen in a list:
  // swipe moves, tap sets (a swipe never saves anything). Double tap goes back (help, list) or opens the system exit
  // dialog (root); polling stops only once the user confirms.
  const requestExit = createExitRequest(bridge, { onConfirmed: () => { closed = true; clearInterval(timer); } }, "endurance-hud");
  const show = (next: typeof screen): void => { screen = next; void draw(); };
  const openSportList = (): void => { sportCursor = Math.max(0, SPORT_CHOICES.indexOf(choice === "run" || choice === "bike" ? choice : null)); show("sport"); };
  await draw();
  renderPhone();
  void refresh();
  timer = setInterval(() => void refresh(), 2000);
  bridge.onEvenHubEvent((event) => {
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      if (menuId === MENU.help) show("help");
      else if (menuId === MENU.sport) openSportList();
      return;
    }
    const gesture = gestureFromEvent(event, { invertScroll: invertScroll() });
    if (!gesture) return;
    if (gesture.gesture === "doubleClick") {
      if (screen !== "live") show("live");
      else void requestExit();
      return;
    }
    if (screen === "help") {
      if (gesture.gesture === "click") show("live");
      return;
    }
    if (screen === "sport") {
      if (gesture.gesture === "scrollDown") { sportCursor = Math.min(SPORT_CHOICES.length - 1, sportCursor + 1); void draw(); }
      else if (gesture.gesture === "scrollUp") { sportCursor = Math.max(0, sportCursor - 1); void draw(); }
      else if (gesture.gesture === "click") { setSport(SPORT_CHOICES[sportCursor] ?? null); show("live"); }
      return;
    }
    if (gesture.gesture === "click") { void refresh(); return; }
    // Without a working side menu (see SIDE_MENU): hold opens the help, swipe cycles the sport (as before QIS v1.2).
    if (SIDE_MENU) return;
    if (gesture.gesture === "longPress") { show("help"); return; }
    if (gesture.gesture === "scrollDown" || gesture.gesture === "scrollUp") setSport(nextSport(sport(), gesture.gesture === "scrollDown" ? 1 : -1));
  });
  bridge.onDeviceStatusChanged((device) => { if (device?.connectType === "connected" && !closed) { pageReady = false; last = ""; void draw(); } });
}
void boot().catch((error: unknown) => console.error("[endurance-hud]", error));
