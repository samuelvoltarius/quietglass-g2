import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { appStore } from "./storage/kv";
import { createExitRequest } from "./exit";
import { createTextPage, updateTextPage, type MenuSpec } from "./glasses/text";
import { helpView, listFooter, viewWords } from "./glasses/help";
import { glassesView, modeLabel, type FeedStatus } from "./glasses/view";
import { languageSelect, rememberLocale, resolveLocale, setLocale, type Locale } from "./i18n";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { fetchPositions } from "./markets/fetch";
import { cents, demoPositions, money, staleAge } from "./markets/model";
import { escapeHtml } from "./ui/html";
const DEFAULT_ENDPOINT = "http://127.0.0.1:8793/positions";
const words = { de: { stale: "VERALTET", error: "Letzter Fehler", realized: "realisiert", title: "POSITIONEN", demo: "DEMO", live: "LIVE", tabs: ["Positionen", "Brille", "Verbindung", "Mehr"], invert: "Wischrichtung umkehren", invertHint: "Nur nötig, wenn Wischen nach oben die Auswahl nach unten bewegt.", about: "Über Market Glance", lede: "Read-only Positionen von Polymarket und Kalshi.", endpoint: "Lokale Markt-Bridge", save: "Speichern", empty: "Keine offenen Positionen", warning: "Nur Anzeige. Keine Orders, keine Kauf- oder Verkaufsgesten." }, en: { stale: "STALE", error: "Last error", realized: "realized", title: "POSITIONS", demo: "DEMO", live: "LIVE", tabs: ["Positions", "Glasses", "Connection", "More"], invert: "Invert swipe direction", invertHint: "Only needed if swiping up moves the selection down.", about: "About Market Glance", lede: "Read-only positions from Polymarket and Kalshi.", endpoint: "Local market bridge", save: "Save", empty: "No open positions", warning: "Display only. No orders, buying, or selling gestures." }, fr: { stale: "PÉRIMÉ", error: "Dernière erreur", realized: "réalisé", title: "POSITIONS", demo: "DÉMO", live: "LIVE", tabs: ["Positions", "Lunettes", "Connexion", "Plus"], invert: "Inverser le sens du glissement", invertHint: "Utile seulement si glisser vers le haut descend la sélection.", about: "À propos de Market Glance", lede: "Positions en lecture seule de Polymarket et Kalshi.", endpoint: "Passerelle locale", save: "Enregistrer", empty: "Aucune position ouverte", warning: "Affichage uniquement. Aucun ordre ni geste d'achat ou de vente." }, es: { stale: "ANTIGUO", error: "Último error", realized: "realizado", title: "POSICIONES", demo: "DEMO", live: "EN VIVO", tabs: ["Posiciones", "Gafas", "Conexión", "Más"], invert: "Invertir sentido de deslizar", invertHint: "Solo si deslizar hacia arriba baja la selección.", about: "Acerca de Market Glance", lede: "Posiciones de solo lectura de Polymarket y Kalshi.", endpoint: "Puente local", save: "Guardar", empty: "Sin posiciones abiertas", warning: "Solo visualización. Sin órdenes ni gestos de compra o venta." }, it: { stale: "VECCHIO", error: "Ultimo errore", realized: "realizzato", title: "POSIZIONI", demo: "DEMO", live: "LIVE", tabs: ["Posizioni", "Occhiali", "Connessione", "Altro"], invert: "Inverti direzione di scorrimento", invertHint: "Serve solo se scorrere in alto sposta la selezione in basso.", about: "Informazioni su Market Glance", lede: "Posizioni in sola lettura da Polymarket e Kalshi.", endpoint: "Bridge locale", save: "Salva", empty: "Nessuna posizione aperta", warning: "Solo visualizzazione. Nessun ordine o gesto di acquisto/vendita." } } as const;
/** The glasses' side menu (QIS v1.2). Off: its clicks do not arrive on current firmware and the hold opens it (step log of the real glasses, 15.10.2026). Help is a list row again. */
const SIDE_MENU = false;
/** Side menu id (QIS v1.2): Hilfe. The app has no settings of its own on the glasses. */
export const MENU_HELP = 1;
const sideMenu = (locale: Locale): MenuSpec => ({ items: !SIDE_MENU ? [] : [{ id: MENU_HELP, label: viewWords[locale].help }] });
const TABS = ["positions", "glasses", "connection", "more"] as const;
type Tab = (typeof TABS)[number];
const INVERT_KEY = "markets.invert";
async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();
  await appStore.init(bridge, ["quietglass.locale", "markets.endpoint", INVERT_KEY]);
  let locale = await resolveLocale(bridge); setLocale(locale);
  let positions = demoPositions(); let status: FeedStatus = { source: "demo", updatedAt: Date.now(), failed: false, errors: [] }; let lastError = "";
  // cursor indexes the positions (+ the Hilfe row when SIDE_MENU is off, then positions.length = Hilfe); help is the open help page.
  let cursor = 0; let help = false; let tab: Tab = "positions";
  let pageReady = false; let last = ""; let timer: ReturnType<typeof setInterval> | undefined; let loading = false; let again = false; let closed = false;
  const t = () => words[locale];
  const mode = (): string => modeLabel(status, Date.now(), t());
  const invert = (): boolean => appStore.get(INVERT_KEY) === "1";
  const view = () => {
    if (help) return helpView(locale);
    const w = viewWords[locale];
    // QIS v1.2 #7: the demo says so in one line; fresh live data does not.
    return glassesView(positions, cursor, { mode: mode(), title: t().title, empty: t().empty, controls: listFooter(locale), ...(SIDE_MENU ? {} : { help: w.help, helpControls: listFooter(locale, true) }), ...(status.source === "demo" ? { demoHint: w.demoHint } : {}) });
  };
  const draw = async (): Promise<void> => { if (closed) return; const next = view(); const sig = JSON.stringify(next); if (sig === last) return; pageReady = pageReady ? await updateTextPage(bridge, next) : await createTextPage(bridge, next, sideMenu(locale)); if (pageReady) last = sig; };
  const phoneIdle = (): boolean => !document.activeElement?.matches("#app input, #app select");
  // A call while one is in flight (e.g. Save with a new endpoint) is not dropped: exactly one follow-up runs as soon as the current one ends.
  const refresh = async (): Promise<void> => {
    if (closed) return; if (loading) { again = true; return; } loading = true; again = false;
    try {
      const onHelpRow = !SIDE_MENU && cursor >= positions.length;
      const result = await fetchPositions(appStore.get("markets.endpoint") || DEFAULT_ENDPOINT);
      positions = result.positions; status = { source: result.source, updatedAt: result.updatedAt ?? Date.now(), failed: false, errors: result.errors };
      lastError = result.errors.map((error) => `${error.provider || "?"}: ${error.message}`).join("; ");
      cursor = onHelpRow ? positions.length : Math.min(cursor, SIDE_MENU ? Math.max(0, positions.length - 1) : positions.length);
    } catch (error) { console.warn("[market-glance] bridge unavailable", error); status = { ...status, failed: true }; lastError = error instanceof Error ? error.message : String(error); } finally { loading = false; }
    last = ""; await draw(); if (phoneIdle()) renderPhone(); if (again) await refresh();
  };
  const content = (): string => {
    const warn = status.source === "demo" || status.errors.length > 0 || staleAge(status.updatedAt, Date.now(), status.failed) !== null;
    switch (tab) {
      case "positions": return `<section class="card"><div class="status-row"><span class="status-dot ${warn ? "warn" : ""}"></span><strong>${escapeHtml(mode())}</strong></div>${lastError ? `<p class="error">${t().error}: ${escapeHtml(lastError)}</p>` : ""}<div class="positions">${positions.map((position) => `<article><small>${escapeHtml(position.provider.toUpperCase() || "?")} · ${escapeHtml(position.outcome)}</small><strong>${escapeHtml(position.title)}</strong><span>${cents(position.price)} · ${money(position.pnl)}${position.realizedPnl === undefined ? "" : ` · ${t().realized} ${money(position.realizedPnl)}`}</span></article>`).join("") || `<p>${t().empty}</p>`}</div></section>`;
      case "glasses": return `<section class="card">${languageSelect(locale)}<label class="check"><input id="invert" type="checkbox"${invert() ? " checked" : ""}> ${t().invert}</label><p class="hint">${t().invertHint}</p></section>`;
      case "connection": return `<section class="card"><label>${t().endpoint}<input id="endpoint" type="text" value="${escapeHtml(appStore.get("markets.endpoint") || DEFAULT_ENDPOINT)}"></label><button id="save">${t().save}</button></section>`;
      default: return `<section class="card"><h2>${t().about}</h2><p class="lede">${t().lede}</p><p class="hint">${t().warning}</p></section>`;
    }
  };
  const renderPhone = (): void => {
    const app = document.querySelector<HTMLDivElement>("#app"); if (!app) return;
    app.innerHTML = `<header class="brand"><div class="brand-mark">QUIETGLASS / READ ONLY</div><h1>Market Glance</h1></header>${content()}<nav class="tabbar" role="tablist">${TABS.map((id, index) => `<button type="button" role="tab" data-tab-go="${id}" class="${id === tab ? "on" : ""}" aria-selected="${id === tab}">${t().tabs[index]}</button>`).join("")}</nav>`;
    document.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => button.addEventListener("click", () => { tab = (button.dataset["tabGo"] as Tab) ?? "positions"; renderPhone(); }));
    document.querySelector("#language")?.addEventListener("change", (event) => { locale = (event.target as HTMLSelectElement).value as Locale; rememberLocale(bridge, locale); last = ""; pageReady = false; void draw(); renderPhone(); });
    document.querySelector("#invert")?.addEventListener("change", (event) => { appStore.set(INVERT_KEY, (event.target as HTMLInputElement).checked ? "1" : "0"); });
    document.querySelector("#save")?.addEventListener("click", () => { const input = document.querySelector<HTMLInputElement>("#endpoint"); if (input) appStore.set("markets.endpoint", input.value.trim()); void refresh(); });
  };
  // Double tap opens the system exit dialog; polling stops only once the user confirms.
  const requestExit = createExitRequest(bridge, { onConfirmed: () => { closed = true; clearInterval(timer); } }, "market-glance");
  await draw(); renderPhone(); void refresh(); timer = setInterval(() => void refresh(), 15000);
  bridge.onEvenHubEvent((event) => {
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) { if (SIDE_MENU && menuId === MENU_HELP && !closed) { help = true; last = ""; void draw(); } return; }
    const gesture = gestureFromEvent(event, { invertScroll: invert() }); if (!gesture) return;
    // Help is a list row (SIDE_MENU off) or in the side menu. 2x only goes back (in Hilfe: to the list; on the root list: the exit dialog). Swipes only move. Nothing here changes data.
    if (gesture.gesture === "doubleClick") { if (help) { help = false; last = ""; void draw(); } else void requestExit(); return; }
    if (gesture.gesture === "click") { if (help) help = false; else if (!SIDE_MENU && cursor >= positions.length) help = true; else { void refresh(); return; } last = ""; void draw(); return; }
    if (help) return;
    if (gesture.gesture === "scrollDown") cursor = Math.min(SIDE_MENU ? Math.max(0, positions.length - 1) : positions.length, cursor + 1);
    if (gesture.gesture === "scrollUp") cursor = Math.max(0, cursor - 1);
    last = ""; void draw();
  });
  bridge.onDeviceStatusChanged((device) => { if (device?.connectType === "connected" && !closed) { pageReady = false; last = ""; void draw(); } });
}
void boot().catch((error: unknown) => console.error("[market-glance]", error));
