import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { appStore } from "./storage/kv";
import { createTextPage, updateTextPage, type MenuSpec, type TextView } from "./glasses/text";
import { languageSelect, rememberLocale, resolveLocale, setLocale, tr, type Locale } from "./i18n";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { captionFooter, helpView } from "./glasses/help";
import { createExitRequest } from "./exit";
import { messages } from "./messages";
import { bridgeUrl, fetchText } from "./podcast/bridge";
import { failureFor, type Failure } from "./podcast/errors";
import { demoCaptions, parsePodcastFeed, readTranscript, type Caption } from "./podcast/parse";
import { captionDelay, createPlayer } from "./podcast/player";
import { BODY_ROWS, LINE_WIDTH, captionRows, errorRow, escapeHtml, formatTime } from "./podcast/view";

const DEFAULT_API = "http://127.0.0.1:8789";
type Source = "DEMO" | "FILE" | "RSS";
const SOURCE_TAG: Record<Source, string> = { DEMO: "tagDemo", FILE: "tagFile", RSS: "tagFeed" };
const INVERT_KEY = "podcaption.invert";
/** QIS v1.2: ids of the glasses' side menu (Hold opens it). */
export const MENU = { help: 1, swipe: 2 } as const;
/** The glasses' side menu (QIS v1.2). Off: its clicks never arrive and a hold opens it instead of reaching the app (step log from the real glasses, 15.10.2026). */
export const SIDE_MENU = false;
const TABS = ["captions", "glasses", "connection", "more"] as const;
type Tab = (typeof TABS)[number];

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();
  await appStore.init(bridge, ["quietglass.locale", "podcaption.bridge", INVERT_KEY]); let locale = await resolveLocale(bridge); setLocale(locale);
  const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
  /** The first-run captions are a how-to in the user's language, not sample podcast text. */
  const demo = (): Caption[] => demoCaptions([t("demo1"), t("demo2"), t("demo3"), t("demo4")]);
  let captions: Caption[] = demo(); let episode = t("demoTitle"); let cursor = 0; let source: Source = "DEMO"; let pageReady = false; let pageMenuKey = ""; let last = ""; let failure: Failure | null = null; let closed = false; let help = false; let tab: Tab = "captions";
  const errorText = (): string => failure ? t(failure.key, { status: failure.status ?? "" }) : "";
  /** QIS v1.2: the glasses never show a status code; the phone keeps the detail. */
  const glassesErrorText = (): string => failure ? t(failure.key === "errServer" ? "errServerGlasses" : failure.key) : "";
  const invert = (): boolean => appStore.get(INVERT_KEY) === "1";
  const view = (): TextView => help ? helpView(locale) : ({ header: `PODCAPTION · ${t(player.playing ? "tagPlay" : "tagPause")} · ${t(SOURCE_TAG[source])}`.slice(0, LINE_WIDTH), body: failure ? [...captionRows(episode, captions, cursor, BODY_ROWS - 1), errorRow(glassesErrorText())] : captionRows(episode, captions, cursor), footer: captionFooter(locale, player.playing) });
  /** QIS v1.2: Hold opens the side menu: Hilfe and the swipe direction (its label names the state, so a change rebuilds the page once). */
  const menuSpec = (): MenuSpec => SIDE_MENU ? ({ key: `${locale}:${invert() ? 1 : 0}`, items: [{ id: MENU.help, label: t("mHelp") }, { id: MENU.swipe, label: t(invert() ? "mSwipeInverted" : "mSwipeNormal") }] }) : { key: "none", items: [] };
  const draw = async (): Promise<void> => {
    if (closed) return; const next = view(); const menu = menuSpec(); const sig = JSON.stringify(next);
    if (sig === last && menu.key === pageMenuKey) return;
    if (pageReady && menu.key !== pageMenuKey) pageReady = false;
    const result = pageReady ? await updateTextPage(bridge, next) : await createTextPage(bridge, next, menu);
    if (result.ok) { if (!pageReady) pageMenuKey = menu.key; pageReady = true; last = sig; } else pageReady = false;
  };
  // Errors reach the phone in full and the glasses as one cut-down row; the raw cause stays in the console.
  const fail = (cause: unknown): void => { console.warn("[podcaption]", cause); failure = failureFor(cause); last = ""; void draw(); renderPhone(); };
  const useCaptions = async (parsed: Caption[], title: string, nextSource: Source): Promise<void> => { player.stop(); captions = parsed; episode = title || t("transcript"); source = nextSource; cursor = 0; failure = null; last = ""; await draw(); renderPhone(); };
  /** Newest episode with a transcript; its files are tried best first (VTT, SRT, JSON, then HTML/text), so one broken link does not end the load. */
  const loadFeed = async (): Promise<void> => { const api = appStore.get("podcaption.bridge") || DEFAULT_API; try { const first = parsePodcastFeed(await fetchText(bridgeUrl(api, "/feed"), "feed"))[0]; if (!first) throw new Error("feed has no podcast:transcript"); let lastFailure: unknown = new Error("transcript unavailable"); for (const transcript of first.transcripts) { try { await useCaptions(readTranscript(await fetchText(bridgeUrl(api, `/transcript?url=${encodeURIComponent(transcript.url)}`), "transcript"), transcript.type), first.title, "RSS"); return; } catch (cause) { lastFailure = cause; } } throw lastFailure; } catch (cause) { fail(cause); } };
  const player = createPlayer({ delayMs: (index) => captionDelay(captions, index), length: () => captions.length, cursor: () => cursor, setCursor: (next) => { cursor = next; }, onChange: () => { last = ""; void draw(); renderLive(); } }); const toggle = (): void => player.toggle();
  const previewHtml = (): string => captions.slice(cursor, cursor + 3).map((caption) => `<p><time>${formatTime(caption.start)}</time>${escapeHtml(caption.text)}</p>`).join("");
  /** Playback and scrolling touch only the preview and the button; a full re-render every caption wiped what the user was typing. */
  const renderLive = (): void => { const preview = document.querySelector<HTMLDivElement>(".caption-preview"); const button = document.querySelector<HTMLButtonElement>("#toggle"); if (!preview || !button) { if (tab === "captions") renderPhone(); return; } preview.innerHTML = previewHtml(); button.textContent = t(player.playing ? "pause" : "play"); };
  const nextStep = (): string => failure ? t("nextError", { error: errorText() }) : source === "DEMO" ? t("nextDemo") : t("nextReady", { episode });
  const renderPhone = (): void => {
    const app = document.querySelector<HTMLDivElement>("#app"); if (!app) return;
    // A half-typed title or pasted text survives a re-render caused by an error or a language switch.
    const typedTitle = document.querySelector<HTMLInputElement>("#title")?.value ?? ""; const pasted = document.querySelector<HTMLTextAreaElement>("#paste")?.value ?? "";
    const open = `<section class="card"><h2>${t("open")}</h2><label>${t("file")}<input id="transcript-file" type="file" accept=".vtt,.srt,.json,.txt,text/vtt,application/json,text/plain"></label><label>${t("title")}<input id="title" type="text" value="${escapeHtml(typedTitle)}"></label><p class="hint">${t("help")}</p><label>${t("paste")}<textarea id="paste" rows="4" placeholder="${escapeHtml(t("pasteHint"))}">${escapeHtml(pasted)}</textarea></label><button id="use-paste">${t("usePaste")}</button></section>`;
    const playerCard = `<section class="card"><div class="status-row"><span class="status-dot ${source === "DEMO" ? "warn" : ""}"></span><strong>${t(source === "DEMO" ? "demo" : "connected")}</strong></div>${failure ? `<p class="error">${t("error")}: ${escapeHtml(errorText())}</p>` : ""}<h2>${escapeHtml(episode)}</h2><div class="caption-preview">${previewHtml()}</div><button id="toggle">${t(player.playing ? "pause" : "play")}</button></section>`;
    const connection = `<section class="card"><h2>${t("bridge")}</h2><p class="hint">${t("bridgeHelp")}</p><label>${t("endpoint")}<input id="endpoint" type="text" value="${escapeHtml(appStore.get("podcaption.bridge") || DEFAULT_API)}"></label><button id="connect">${t("connect")}</button></section>`;
    const glasses = `<section class="card">${languageSelect(locale)}<label class="check"><input id="invert" type="checkbox"${invert() ? " checked" : ""}> ${t("invert")}</label><p class="hint">${t("invertHint")}</p></section>`;
    const more = `<section class="card"><h2>${t("about")}</h2><p class="lede">${t("lede")}</p><p class="hint">${t("help")}</p></section>`;
    const content = tab === "captions" ? `<p class="next">${escapeHtml(nextStep())}</p>${source === "DEMO" ? open + playerCard : playerCard + open}` : tab === "glasses" ? glasses : tab === "connection" ? connection : more;
    const tabLabels = [t("tabCaptions"), t("tabGlasses"), t("tabConnection"), t("tabMore")];
    app.innerHTML = `<header class="brand"><div class="brand-mark">QUIETGLASS / ACCESSIBILITY</div><h1>PodCaption</h1></header>${content}<nav class="tabbar" role="tablist">${TABS.map((id, index) => `<button type="button" role="tab" data-tab-go="${id}" class="${id === tab ? "on" : ""}" aria-selected="${id === tab}">${tabLabels[index]}</button>`).join("")}</nav>`;
    document.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => button.addEventListener("click", () => { tab = (button.dataset["tabGo"] as Tab) ?? "captions"; renderPhone(); }));
    document.querySelector("#invert")?.addEventListener("change", (event) => { appStore.set(INVERT_KEY, (event.target as HTMLInputElement).checked ? "1" : "0"); void draw(); });
    document.querySelector("#language")?.addEventListener("change", (event) => { locale = (event.target as HTMLSelectElement).value as Locale; rememberLocale(bridge, locale); if (source === "DEMO") { captions = demo(); episode = t("demoTitle"); } last = ""; void draw(); renderPhone(); });
    document.querySelector("#toggle")?.addEventListener("click", toggle);
    const titleFor = (fallback: string): string => document.querySelector<HTMLInputElement>("#title")?.value.trim() || fallback;
    document.querySelector("#transcript-file")?.addEventListener("change", async (event) => { const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return; const title = titleFor(file.name.replace(/\.[^.]+$/, "")); const mime = file.type || (file.name.endsWith(".json") ? "application/json" : "text/vtt"); try { await useCaptions(readTranscript(await file.text(), mime), title, "FILE"); } catch (cause) { fail(cause); } });
    document.querySelector("#use-paste")?.addEventListener("click", async () => { const text = document.querySelector<HTMLTextAreaElement>("#paste")?.value ?? ""; if (!text.trim()) { failure = { key: "errPasteEmpty" }; last = ""; void draw(); renderPhone(); return; } try { await useCaptions(readTranscript(text, text.trimStart().startsWith("{") ? "application/json" : "text/vtt"), titleFor(t("transcript")), "FILE"); } catch (cause) { fail(cause); } });
    document.querySelector("#connect")?.addEventListener("click", () => { const input = document.querySelector<HTMLInputElement>("#endpoint"); if (input) appStore.set("podcaption.bridge", input.value.trim()); void loadFeed(); });
  };
  // Double tap opens the system exit dialog; playback continues until the user confirms.
  const requestExit = createExitRequest(bridge, { onConfirmed: () => { closed = true; player.stop(); } }, "podcaption");
  await draw(); renderPhone();
  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    // QIS v1.2: help and the swipe setting come from the glasses' side menu, never from a gesture.
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      if (menuId === MENU.help) { help = true; last = ""; void draw(); }
      else if (menuId === MENU.swipe) { appStore.set(INVERT_KEY, invert() ? "0" : "1"); last = ""; void draw(); if (tab === "glasses") renderPhone(); }
      return;
    }
    const gesture = gestureFromEvent(event, { invertScroll: invert() }); if (!gesture) return;
    // QIS v1: 2x is back (help -> captions) and only on the captions page the exit dialog; it never ends playback by itself.
    if (gesture.gesture === "doubleClick") { if (help) { help = false; last = ""; void draw(); } else void requestExit(); return; }
    // With the side menu on, a hold opens the system menu and the app does nothing on it. Without it (SIDE_MENU), a hold opens the help again.
    if (gesture.gesture === "longPress" || gesture.gesture === "longPressRelease") { if (!SIDE_MENU && gesture.gesture === "longPress" && !help) { help = true; last = ""; void draw(); } return; }
    if (help) { if (gesture.gesture === "click") { help = false; last = ""; void draw(); } return; }
    if (gesture.gesture === "click") { toggle(); return; }
    if (gesture.gesture !== "scrollDown" && gesture.gesture !== "scrollUp") return;
    if (gesture.gesture === "scrollDown") cursor = Math.max(0, Math.min(captions.length - 1, cursor + 1));
    if (gesture.gesture === "scrollUp") cursor = Math.max(0, cursor - 1);
    player.resync(); last = ""; void draw(); renderLive();
  });
  bridge.onDeviceStatusChanged((status) => { if (status?.connectType === "connected" && !closed) { pageReady = false; last = ""; void draw(); } });
}
void boot().catch((error: unknown) => console.error("[podcaption]", error));
