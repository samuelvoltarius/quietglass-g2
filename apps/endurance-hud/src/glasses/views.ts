import type { Locale } from "../i18n";
import { elapsed, pace, paceOf, speedOf, type Sport, type Telemetry } from "../telemetry/model";
import { words } from "../words";
import { footer, fit, GESTURE_WORDS } from "./footer";
import type { TextView } from "./text";

/** Wording of the QIS v1 screens (footer verbs, help page, phone tabs). */
export const qis = {
  de: { refresh: "neu", sport: "Sport", help: "Hilfe", helpTitle: "Hilfe", tapHelp: "Werte neu laden", swipeHelp: "Sport wechseln (Rad / Laufen)", holdHelp: "diese Hilfe", needs: "Braucht: Telemetrie-Bridge (sonst Demo)", back: "zurück", menuSport: "Sportart", menuHelp: "Hilfe", move: "bewegen", pick: "setzen", tabLive: "Live", tabGlasses: "Brille", tabBridge: "Verbindung", tabMore: "Mehr", invert: "Wischrichtung umkehren", invertHint: "Wischen wechselt die Sportart; mit dieser Option läuft die Richtung andersherum.", moreVersion: "Version", morePrivacy: "Die App speichert Sportart, Sprache und Bridge-Adresse nur auf dem Handy. Keine Garmin-Zugangsdaten." },
  en: { refresh: "refresh", sport: "sport", help: "help", helpTitle: "Help", tapHelp: "reload values", swipeHelp: "switch sport (bike / run)", holdHelp: "this help", needs: "Needs: telemetry bridge (demo without)", back: "back", menuSport: "Sport", menuHelp: "Help", move: "move", pick: "set", tabLive: "Live", tabGlasses: "Glasses", tabBridge: "Connection", tabMore: "More", invert: "Reverse swipe direction", invertHint: "Swiping switches the sport; this option reverses the direction.", moreVersion: "Version", morePrivacy: "The app keeps sport, language and bridge address on the phone only. No Garmin credentials." },
  fr: { refresh: "actualiser", sport: "sport", help: "aide", helpTitle: "Aide", tapHelp: "actualiser les valeurs", swipeHelp: "changer de sport (vélo / course)", holdHelp: "cette aide", needs: "Requis : passerelle télémétrie (sinon démo)", back: "retour", menuSport: "Sport", menuHelp: "Aide", move: "déplacer", pick: "choisir", tabLive: "Live", tabGlasses: "Lunettes", tabBridge: "Connexion", tabMore: "Plus", invert: "Inverser le sens du balayage", invertHint: "Le balayage change de sport ; cette option inverse le sens.", moreVersion: "Version", morePrivacy: "Sport, langue et adresse restent sur le téléphone. Aucun identifiant Garmin." },
  es: { refresh: "actualizar", sport: "deporte", help: "ayuda", helpTitle: "Ayuda", tapHelp: "actualizar valores", swipeHelp: "cambiar deporte (bici / carrera)", holdHelp: "esta ayuda", needs: "Requiere: puente de telemetría (si no, demo)", back: "atrás", menuSport: "Deporte", menuHelp: "Ayuda", move: "mover", pick: "elegir", tabLive: "Live", tabGlasses: "Gafas", tabBridge: "Conexión", tabMore: "Más", invert: "Invertir sentido del deslizamiento", invertHint: "Deslizar cambia de deporte; esta opción invierte el sentido.", moreVersion: "Versión", morePrivacy: "Deporte, idioma y dirección del puente quedan solo en el teléfono. Sin credenciales Garmin." },
  it: { refresh: "aggiorna", sport: "sport", help: "aiuto", helpTitle: "Aiuto", tapHelp: "aggiorna i valori", swipeHelp: "cambia sport (bici / corsa)", holdHelp: "questo aiuto", needs: "Richiede: bridge telemetria (altrimenti demo)", back: "indietro", menuSport: "Sport", menuHelp: "Aiuto", move: "sposta", pick: "imposta", tabLive: "Live", tabGlasses: "Occhiali", tabBridge: "Connessione", tabMore: "Altro", invert: "Inverti il verso dello scorrimento", invertHint: "Scorrere cambia sport; questa opzione inverte il verso.", moreVersion: "Versione", morePrivacy: "Sport, lingua e indirizzo restano solo sul telefono. Nessuna credenziale Garmin." },
} as const satisfies Record<Locale, Record<string, string>>;

/** The live screen: `ENDURANCE HUD · state`, the values, the gesture footer. */
export function liveView(locale: Locale, mode: string, sport: Sport, data: Telemetry): TextView {
  const t = words[locale];
  const q = qis[locale];
  return {
    header: fit(`ENDURANCE HUD · ${mode}`),
    body: [
      `${sport.toUpperCase()}  ${t.elapsed}: ${elapsed(data.elapsedSeconds)}  ${t.distance}: ${data.distanceKm.toFixed(1)} km`,
      "",
      sport === "run" ? `${t.pace.toUpperCase()}  ${pace(paceOf(data))} /km` : `${t.speed.toUpperCase()}  ${speedOf(data).toFixed(1)} km/h`,
      `${t.power.toUpperCase()}  ${Math.round(data.powerWatts)} W`,
      `${t.heart.toUpperCase()}  ${Math.round(data.heartRate)} bpm`,
      `${t.cadence.toUpperCase()}  ${Math.round(data.cadence)} rpm`,
    ],
    footer: footer(locale, { tap: q.refresh, swipe: q.sport, hold: q.help }, "exit"),
  };
}

/** The sport list (only reachable with the side menu, see SIDE_MENU in main.ts) (side menu "Sportart"): swipe moves, tap sets, 2× goes back without changing anything. */
export function sportListView(locale: Locale, cursor: number, current: Sport | null): TextView {
  const t = words[locale];
  const q = qis[locale];
  const options: readonly [Sport | null, string][] = [[null, t.auto], ["bike", t.bike], ["run", t.run]];
  return {
    header: fit(`ENDURANCE HUD · ${q.menuSport}`),
    body: options.map(([value, name], index) => fit(`${index === cursor ? ">" : " "} ${name}${value === current ? " ●" : ""}`)),
    footer: footer(locale, { tap: q.pick, swipe: q.move }, "back"),
  };
}

/** Rows of the sport list, in order (the cursor index points into this). */
export const SPORT_CHOICES: readonly (Sport | null)[] = [null, "bike", "run"];

/** The help page: the gestures in footer order, then what the app needs. */
export function helpView(locale: Locale): TextView {
  const q = qis[locale];
  const g = GESTURE_WORDS[locale];
  return {
    header: `ENDURANCE HUD · ${q.helpTitle}`,
    body: [
      `${g.tap} = ${q.tapHelp}`,
      `${g.swipe} = ${q.swipeHelp}`,
      `${g.hold} = ${q.holdHelp}`,
      `2× = ${g.exit} (${q.helpTitle}: ${g.back})`,
      "",
      q.needs,
    ].map((row) => fit(row)),
    footer: footer(locale, { tap: q.back }, "back"),
  };
}
