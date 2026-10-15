import type { Locale } from "../i18n";
import { footer, ROW_WIDTH } from "./footer";
import type { TextView } from "./text";

/** Per-language words of the list footer, the Hilfe entry and the help page (QIS v1). */
export interface ViewWords {
  readonly help: string;
  readonly refresh: string;
  readonly open: string;
  readonly choose: string;
  readonly close: string;
  /** The one-line hint of the demo (QIS v1.2 #7). */
  readonly demoHint: string;
  readonly helpRows: readonly [string, string, string, string, string];
}

export const viewWords: Record<Locale, ViewWords> = {
  de: { help: "Hilfe", refresh: "neu", open: "öffnen", choose: "wählen", close: "schließen", demoHint: "Demo · Verbindung am Handy einrichten", helpRows: ["Tippen = neu laden · bei Hilfe: öffnen", "Wischen = Position wählen", "Halten = ohne Funktion (nur Anzeige)", "2× = Ende · in der Hilfe: zurück", "Braucht: lokale Markt-Bridge · nur lesen"] },
  en: { help: "Help", refresh: "reload", open: "open", choose: "select", close: "close", demoHint: "Demo · set up the connection on the phone", helpRows: ["Tap = reload · on Help: open", "Swipe = select a position", "Hold = nothing (display only)", "2× = exit · in Help: back", "Needs: local market bridge · read-only"] },
  fr: { help: "Aide", refresh: "actualiser", open: "ouvrir", choose: "choisir", close: "fermer", demoHint: "Démo · régler la connexion sur le téléphone", helpRows: ["Taper = actualiser · sur Aide: ouvrir", "Glisser = choisir une position", "Maintenir = rien (affichage seul)", "2× = fin · dans l'aide: retour", "Requiert: passerelle locale · lecture seule"] },
  es: { help: "Ayuda", refresh: "actualizar", open: "abrir", choose: "elegir", close: "cerrar", demoHint: "Demo · configura la conexión en el móvil", helpRows: ["Tocar = actualizar · en Ayuda: abrir", "Deslizar = elegir posición", "Mantener = nada (solo vista)", "2× = salir · en Ayuda: atrás", "Requiere: puente local · solo lectura"] },
  it: { help: "Aiuto", refresh: "aggiorna", open: "apri", choose: "scegli", close: "chiudi", demoHint: "Demo · imposta la connessione sul telefono", helpRows: ["Tocca = aggiorna · su Aiuto: apri", "Scorri = scegli posizione", "Tieni = niente (solo vista)", "2× = esci · in Aiuto: indietro", "Richiede: bridge locale · sola lettura"] },
};

/** Footer under the position list: the tap reloads, on the Hilfe row (no side menu, see SIDE_MENU in main.ts) it opens the help. */
export function listFooter(locale: Locale, onHelp = false): string {
  const w = viewWords[locale];
  return footer(locale, { tap: onHelp ? w.open : w.refresh, swipe: w.choose }, "exit");
}

/** The help page: the four gestures in footer order, then what the app needs. */
export function helpView(locale: Locale): TextView {
  const w = viewWords[locale];
  const header = `MARKET GLANCE · ${w.help}`;
  return { header: header.length <= ROW_WIDTH ? header : header.slice(0, ROW_WIDTH), body: ["", ...w.helpRows], footer: footer(locale, { tap: w.close }, "back") };
}
