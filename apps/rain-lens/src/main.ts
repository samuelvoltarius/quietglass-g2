import { AppLocationAccuracy, waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { createTextPage, updateTextPage, type TextView } from "./glasses/text";
import { getLocale, languageSelect, setLocale, tr, type Locale } from "./i18n";
import { gestureFromEvent } from "./input/gestures";
import { messages } from "./messages";
import { fetchForecast, parseCoordinates } from "./rain/api";
import { searchPlaces, usableQuery, type Place } from "./rain/geocode";
import { KEYS, errorKey, noticeKey, resolveLocation, storedMode, storedSources, type ResolvedLocation, type Status } from "./rain/location";
import { clock, dayName, demoWeather, escapeHtml, fit, glassesBody, weatherKind, windCompass, type WeatherForecast } from "./rain/model";
import { renderWeatherIcons } from "./weather/icons";

const round = (value: number): string => `${Math.round(value)}°`;
/** Header and footer span the full 576 px, unlike the body next to the icons. */
const FULL_WIDTH = 46;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();
  let locale = getLocale(); let forecast: WeatherForecast = demoWeather(); let loading = false; let failure: ReturnType<typeof errorKey> | null = null; let pageReady = false; let last = ""; let page = 0;
  let status: Status = "loading"; let where: ResolvedLocation | null = null;
  /** Phone-only state of the place search; never stored. */
  let query = ""; let results: Place[] = []; let searchNote = ""; let coordNote = "";
  const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
  const condition = (code: number): string => t(weatherKind(code));
  const errorText = (): string => failure ? t(failure.key, { status: failure.status ?? "" }) : "";
  const placeName = (): string => where?.label ?? (where?.kind === "manual" ? `${where.position.latitude.toFixed(2)}, ${where.position.longitude.toFixed(2)}` : t("here"));
  const currentLines = (): string[] => {
    const current = forecast.current; const today = forecast.daily[0];
    return [`${condition(current.weatherCode).toUpperCase()}  ${round(current.temperature)}`, `${t("feels")} ${round(current.feelsLike)}   ${t("humidity")} ${Math.round(current.humidity)}%`, `${t("wind")} ${windCompass(current.windDirection)} ${Math.round(current.windSpeed)} km/h   ${t("gusts")} ${Math.round(current.windGusts)}`, `${t("precipitation")} ${current.precipitation.toFixed(1)} mm   ${t("clouds")} ${Math.round(current.cloudCover)}%`, today ? `${t("highLow")} ${round(today.maximum)} / ${round(today.minimum)}` : "", today ? `${t("sun")} ${clock(today.sunrise, locale)} - ${clock(today.sunset, locale)}` : ""].filter(Boolean);
  };
  const hourlyLines = (): string[] => forecast.hourly.slice(0, 6).map((hour) => `${clock(hour.time, locale)}  ${round(hour.temperature).padEnd(4)} ${condition(hour.weatherCode).padEnd(10)} ${Math.round(hour.precipitationProbability)}%`);
  const dailyLines = (): string[] => forecast.daily.map((day) => `${dayName(day.date, locale).toUpperCase().padEnd(4)} ${round(day.maximum)} / ${round(day.minimum)}  ${condition(day.weatherCode).padEnd(10)} ${Math.round(day.precipitationProbability)}%`);
  /** Without a real forecast the glasses say what to do next instead of showing sample numbers that look real. */
  const notice = (): string | null => { const key = noticeKey(status, forecast.source); return key ? t(key) : null; };
  const view = (): TextView => {
    const text = notice(); const tag = forecast.source === "live" ? (where?.label ?? "LIVE").toUpperCase() : t("sampleTag");
    return { header: fit(text ? "RAINLENS" : `RAINLENS  ${[t("now"), t("hourly"), t("days")][page]}  ${tag}`, FULL_WIDTH), body: text ? glassesBody(text.split("\n")) : glassesBody(page === 0 ? currentLines() : page === 1 ? hourlyLines() : dailyLines(), errorText()), footer: fit(loading ? t("updating") : t("controls"), FULL_WIDTH) };
  };
  const draw = async (): Promise<void> => { const text = view(); const signature = JSON.stringify(text); if (signature === last) return; const next: TextView = { ...text, imageData: await renderWeatherIcons(forecast, notice() ? -1 : page) }; const result = pageReady ? await updateTextPage(bridge, next) : await createTextPage(bridge, next); if (result.ok) { pageReady = true; last = signature; } else pageReady = false; };
  const phoneFix = async (): Promise<{ latitude: number; longitude: number } | null> => bridge.getAppLocation({ accuracy: AppLocationAccuracy.Medium, timeoutMs: 8000 });
  const refresh = async (): Promise<void> => {
    if (loading) return; loading = true; failure = null; if (forecast.source === "demo") status = "loading"; await draw(); renderPhone();
    where = await resolveLocation(storedSources(localStorage, phoneFix));
    if (!where) status = "noLocation";
    else {
      try { forecast = await fetchForecast(where.position); status = "live"; }
      catch (cause) { failure = errorKey(cause); if (forecast.source === "demo") status = "offline"; }
    }
    loading = false; last = ""; await draw(); renderPhone();
  };
  const nextStep = (): string => loading && forecast.source === "demo" ? t("nextLoading") : status === "noLocation" ? t("nextNoLocation") : status === "offline" || failure ? t("nextOffline") : status === "live" ? t("nextLive", { place: placeName() }) : t("nextLoading");
  const currentSetting = (): string => { const mode = storedMode(localStorage); const source = storedSources(localStorage, async () => null); if (mode === "place" && source.place) return t("using", { place: source.place.label }); if (mode === "manual" && source.manual) return t("using", { place: `${source.manual.latitude}, ${source.manual.longitude}` }); return mode === "phone" ? t("usingPhone") : t("usingNone"); };
  const renderPhone = (): void => {
    const app = document.querySelector<HTMLDivElement>("#app"); if (!app) return; const mode = storedMode(localStorage); const current = forecast.current; const today = forecast.daily[0];
    const weather = `<section class="card weather-card"><div class="status-row"><span class="status-dot ${forecast.source === "demo" ? "warn" : ""}"></span><strong>${t(forecast.source === "live" ? "live" : "demo")}</strong><time>${clock(current.time, locale)}</time></div><div class="weather-hero"><div><span>${condition(current.weatherCode)}</span><strong>${round(current.temperature)}</strong></div><p>${t("feels")} ${round(current.feelsLike)}</p></div><div class="weather-grid"><div><span>${t("humidity")}</span><b>${Math.round(current.humidity)}%</b></div><div><span>${t("wind")}</span><b>${windCompass(current.windDirection)} ${Math.round(current.windSpeed)}</b><small>km/h</small></div><div><span>${t("precipitation")}</span><b>${current.precipitation.toFixed(1)}</b><small>mm</small></div><div><span>${t("clouds")}</span><b>${Math.round(current.cloudCover)}%</b></div></div>${failure ? `<p class="error">${escapeHtml(errorText())}</p>` : ""}<button id="refresh">${t("refresh")}</button></section>`;
    const location = `<section class="card"><h2>${t("settings")}</h2><p class="hint">${escapeHtml(currentSetting())}</p><label class="check"><input id="automatic" type="checkbox"${mode === "phone" ? " checked" : ""}>${t("automatic")}</label><label>${t("place")}<input id="place" type="text" autocomplete="off" placeholder="${escapeHtml(t("placeHint"))}" value="${escapeHtml(query)}"></label><button id="search">${t("search")}</button>${searchNote ? `<p class="hint">${escapeHtml(searchNote)}</p>` : ""}${results.length ? `<div class="place-list">${results.map((place, index) => `<button class="place" data-index="${index}">${escapeHtml(place.label)}</button>`).join("")}</div>` : ""}</section>`;
    const advanced = `<details class="card advanced"${coordNote ? " open" : ""}><summary>${t("advanced")}</summary><label>${t("latitude")}<input id="lat" type="text" inputmode="decimal" value="${escapeHtml(localStorage.getItem(KEYS.lat) ?? "")}"></label><label>${t("longitude")}<input id="lon" type="text" inputmode="decimal" value="${escapeHtml(localStorage.getItem(KEYS.lon) ?? "")}"></label><button id="coords">${t("useCoords")}</button>${coordNote ? `<p class="error">${escapeHtml(coordNote)}</p>` : ""}<p class="hint">${t("help")}</p></details>`;
    app.innerHTML = `<header class="brand"><div class="brand-mark">QUIETGLASS / WEATHER</div><h1>RainLens</h1><p class="lede">${t("lede")}</p></header><p class="next">${escapeHtml(nextStep())}</p>${status === "noLocation" ? location + weather : weather + location}<section class="card"><div class="section-title"><h2>${t("hourly")}</h2><span>${t("chance")}</span></div><div class="hourly-strip">${forecast.hourly.slice(0, 8).map((hour) => `<div><time>${clock(hour.time, locale)}</time><b>${round(hour.temperature)}</b><span>${condition(hour.weatherCode)}</span><em>${Math.round(hour.precipitationProbability)}%</em></div>`).join("")}</div></section><section class="card"><h2>${t("days")}</h2><div class="forecast-list">${forecast.daily.map((day) => `<div><b>${dayName(day.date, locale)}</b><span>${condition(day.weatherCode)}</span><em>${round(day.maximum)} / ${round(day.minimum)}</em><small>${Math.round(day.precipitationProbability)}%</small></div>`).join("")}</div>${today ? `<div class="sun-row"><span>${t("sun")}</span><b>${clock(today.sunrise, locale)} → ${clock(today.sunset, locale)}</b></div>` : ""}</section><section class="card compact">${languageSelect(locale)}</section>${advanced}<p class="credits">${t("credits")}</p>`;
    document.querySelector("#language")?.addEventListener("change", (event) => { locale = (event.target as HTMLSelectElement).value as Locale; setLocale(locale); last = ""; void draw(); renderPhone(); });
    document.querySelector("#refresh")?.addEventListener("click", () => { void refresh(); });
    document.querySelector("#automatic")?.addEventListener("change", (event) => { const checked = (event.target as HTMLInputElement).checked; const fallback = storedSources(localStorage, async () => null).place ? "place" : "manual"; localStorage.setItem(KEYS.mode, checked ? "phone" : fallback); void refresh(); });
    const search = async (): Promise<void> => {
      query = document.querySelector<HTMLInputElement>("#place")?.value ?? ""; results = [];
      if (!usableQuery(query)) { searchNote = t("tooShort"); renderPhone(); return; }
      searchNote = t("searching"); renderPhone();
      try { results = await searchPlaces(query, locale); searchNote = results.length ? t("pick") : t("noResults"); } catch { searchNote = t("geoError"); }
      renderPhone();
    };
    document.querySelector("#search")?.addEventListener("click", () => { void search(); });
    document.querySelector("#place")?.addEventListener("keydown", (event) => { if ((event as KeyboardEvent).key === "Enter") { event.preventDefault(); void search(); } });
    document.querySelectorAll<HTMLButtonElement>("button.place").forEach((button) => button.addEventListener("click", () => {
      const place = results[Number(button.dataset.index)]; if (!place) return;
      localStorage.setItem(KEYS.place, JSON.stringify(place)); localStorage.setItem(KEYS.mode, "place"); results = []; searchNote = ""; query = ""; void refresh();
    }));
    document.querySelector("#coords")?.addEventListener("click", () => {
      const lat = document.querySelector<HTMLInputElement>("#lat")?.value ?? ""; const lon = document.querySelector<HTMLInputElement>("#lon")?.value ?? "";
      if (!parseCoordinates(lat, lon)) { coordNote = t("badCoords"); renderPhone(); return; }
      coordNote = "";
      localStorage.setItem(KEYS.lat, lat); localStorage.setItem(KEYS.lon, lon); localStorage.setItem(KEYS.mode, "manual"); void refresh();
    });
  };
  await draw(); renderPhone(); void refresh();
  bridge.onEvenHubEvent((event) => { const gesture = gestureFromEvent(event); if (!gesture) return; if (gesture.gesture === "doubleClick") { void bridge.shutDownPageContainer(); return; } if (gesture.gesture === "click") { void refresh(); return; } if (gesture.gesture.startsWith("scroll")) { page = gesture.gesture === "scrollDown" ? (page + 1) % 3 : (page + 2) % 3; last = ""; void draw(); } });
  bridge.onDeviceStatusChanged((status) => { if (status?.connectType === "connected") { pageReady = false; last = ""; void draw(); } });
}
void boot().catch((error: unknown) => console.error("[rainlens]", error));
