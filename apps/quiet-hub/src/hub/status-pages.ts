/**
 * The read-only area pages "Auto" and "Server" (0.11). Both live from the daemon's briefing
 * (`GET /brief`, BRIEF_BYD_URL / BRIEF_STATUS_URLS): no token and no address of a source ever
 * reaches the glasses. The car is shown, never steered from here (Panoptes rules: commands only
 * after Alfred's go and the coordination's sign-off).
 */
import { tr, type Locale } from "../i18n";
import { messages } from "../messages";
import { fit } from "../glasses/screen";
import type { Brief } from "../api/types";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The car commands in row order (Panoptes phone API). Horn, lights, "find car" and the alarm do not exist here. */
export interface CarCommand { readonly aktion: "zusperren" | "klima_an" | "klima_aus" | "aufsperren"; readonly tempC?: number; readonly minuten?: number }
export const CAR_COMMANDS: readonly CarCommand[] = [
  { aktion: "zusperren" },
  { aktion: "klima_an", tempC: 21, minuten: 15 },
  { aktion: "klima_aus" },
  { aktion: "aufsperren" },
];
const translator = (locale: Locale): T => (key, vars = {}) => tr(messages, locale, key, vars);

/** "vor 3 min" / "vor 2 h" since the briefing was collected. */
function age(at: number | undefined, now: number, t: T): string {
  if (typeof at !== "number" || at <= 0) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 1 ? t("st.justNow") : minutes < 120 ? t("st.agoMin", { n: minutes }) : t("st.agoH", { n: Math.round(minutes / 60) });
}

/** `selected` (paired with Panoptes): two status rows, then the commands with the cursor. */
export function carRows(brief: Brief | null | undefined, locale: Locale, now: number, selected: number | null = null): string[] {
  const t = translator(locale);
  const car = brief?.car;
  if (selected !== null) {
    const status: string[] = [];
    if (car === undefined || brief === null || brief === undefined) status.push(t("st.loading"));
    else if (car.status !== "ok" && car.stale !== true) status.push(t(car.status === "off" ? "car.off" : "car.unreachable"));
    else {
      status.push([typeof car.soc === "number" ? `${car.soc} %` : "", typeof car.rangeKm === "number" ? `${car.rangeKm} km` : "", car.locked === true ? t("car.locked") : car.locked === false ? t("car.unlocked") : ""].filter(Boolean).join(" · "));
      status.push([car.charging === true ? t("car.charging") : car.chargeDone === true ? t("car.full") : "", car.stale === true ? t("st.stale", { ago: age(car.since, now, t) }) : t("st.asOf", { ago: age(brief.at, now, t) })].filter(Boolean).join(" · "));
    }
    const commands = CAR_COMMANDS.map((command, i) => `${i === selected ? "> " : "  "}${command.tempC === undefined ? t(`car.act.${command.aktion}`) : t("car.act.klima_an", { t: command.tempC, m: command.minuten ?? 15 })}`);
    return [...status, "", ...commands].map((row) => fit(row));
  }
  if (brief === null || brief === undefined || car === undefined) return [t("st.loading")];
  if (car.status === "off") return [t("car.off"), t("car.offHint")];
  if (car.status === "error" && car.stale !== true) return [t("car.unreachable"), t("st.tapRetry")];
  const rows: string[] = [];
  const battery = [typeof car.soc === "number" ? `${car.soc} %` : "", typeof car.rangeKm === "number" ? `${car.rangeKm} km` : ""].filter(Boolean).join(" · ");
  if (battery !== "") rows.push(t("car.battery", { value: battery }));
  rows.push(t("car.lock", { value: car.locked === true ? t("car.locked") : car.locked === false ? t("car.unlocked") : t("car.unknown") }));
  const charge = car.charging === true
    ? (typeof car.etaMin === "number" && car.etaMin > 0 ? t("car.chargingEta", { n: car.etaMin }) : t("car.charging"))
    : car.chargeDone === true ? t("car.full") : t("car.notCharging");
  rows.push(t("car.charge", { value: charge }));
  if (typeof car.mode === "string" && car.mode !== "") rows.push(t("car.mode", { value: t(`car.mode.${car.mode}`) === `car.mode.${car.mode}` ? car.mode : t(`car.mode.${car.mode}`) }));
  rows.push("");
  rows.push(car.stale === true ? t("st.stale", { ago: age(car.since, now, t) }) : t("st.asOf", { ago: age(brief.at, now, t) }));
  rows.push(t("car.readOnly"));
  return rows.map((row) => fit(row));
}

export function serverRows(brief: Brief | null | undefined, locale: Locale, now: number): string[] {
  const t = translator(locale);
  const servers = brief?.servers;
  if (brief === null || brief === undefined || servers === undefined) return [t("st.loading")];
  if (servers.status === "off") return [t("srv.off"), t("srv.offHint")];
  if (servers.status === "error" && servers.stale !== true) return [t("srv.unreachable"), t("st.tapRetry")];
  const machines = servers.machines ?? [];
  const rows = machines.slice(0, 5).map((machine) => {
    const state = !machine.ok ? t("srv.down") : (machine.warn ?? 0) > 0 ? t("srv.warn", { n: machine.warn ?? 0 }) : t("srv.ok");
    const fresh = machine.newDevices ?? 0;
    return fit(`${machine.ok ? "●" : "○"} ${machine.name} · ${state}${fresh > 0 ? ` · ${t(fresh === 1 ? "srv.newDevice1" : "srv.newDevices", { n: fresh })}` : ""}`);
  });
  if (machines.length === 0) rows.push(t("srv.none"));
  rows.push("");
  rows.push(fit(servers.stale === true ? t("st.stale", { ago: age(servers.since, now, t) }) : t("st.asOf", { ago: age(brief.at, now, t) })));
  return rows.slice(0, 7);
}
