import type { Locale } from "./i18n";

/**
 * Wording of the QUS v1 screens: the hint line verbs, the cockpit's labels and the phone page.
 * Glasses labels are upper case and short (a cell is 82 px wide); the phone has room.
 */
export interface Qis {
  // glasses
  readonly refresh: string; readonly sport: string; readonly back: string;
  readonly cpSport: string; readonly cpAvg: string; readonly cpZone: string; readonly cpLive: string; readonly cpHrMax: string; readonly cpHeart: string;
  // phone
  readonly kicker: string; readonly tabNow: string; readonly tabLog: string; readonly tabSettings: string;
  readonly bannerDemo: string; readonly bannerLive: string; readonly bannerStale: string; readonly bannerError: string;
  readonly refreshNow: string; readonly heroSide: string;
  readonly logTime: string; readonly logAvgHr: string; readonly logMaxHr: string; readonly logAvgPower: string;
  readonly stripTitle: string; readonly stripNone: string;
  readonly setupTitle: string; readonly setup1: string; readonly setup2: string; readonly setup3: string;
  readonly connectionTitle: string; readonly sportTitle: string; readonly maxHr: string; readonly maxHrHint: string;
  readonly glassesTitle: string; readonly invert: string; readonly invertHint: string;
  readonly controlsTitle: string; readonly tapHelp: string; readonly swipeHelp: string; readonly holdHelp: string; readonly doubleHelp: string;
  readonly tap: string; readonly swipe: string; readonly hold: string; readonly double: string;
  readonly moreTitle: string; readonly moreVersion: string; readonly morePrivacy: string;
  readonly zone: string; readonly unitMin: string;
}

export const qis: Record<Locale, Qis> = {
  de: {
    refresh: "neu", sport: "Sport", back: "zurück",
    cpSport: "SPORT", cpAvg: "Ø", cpZone: "ZONE", cpLive: "LIVE", cpHrMax: "PULS MAX", cpHeart: "PULS",
    kicker: "QUIETGLASS / SPORT", tabNow: "Jetzt", tabLog: "Verlauf", tabSettings: "Einstellungen",
    bannerDemo: "Demo-Daten. Trag unter Einstellungen die Adresse deiner Telemetrie-Bridge ein.",
    bannerLive: "Live-Daten von {source}.", bannerStale: "Seit {age} keine frischen Werte.", bannerError: "Bridge nicht erreichbar: {error}",
    refreshNow: "Jetzt neu laden", heroSide: "{sport}",
    logTime: "Zeit", logAvgHr: "Ø Puls", logMaxHr: "Max Puls", logAvgPower: "Ø Leistung",
    stripTitle: "Letzte Minuten", stripNone: "Noch keine Werte.",
    setupTitle: "Erste Schritte", setup1: "Trag die Adresse der Telemetrie-Bridge ein", setup2: "Wähle die Sportart (oder lass Automatisch)", setup3: "Starte das Training: die Werte laufen live",
    connectionTitle: "Verbindung", sportTitle: "Sport und Puls", maxHr: "Maximalpuls — {value} bpm", maxHrHint: "Daraus ergeben sich die fünf Pulszonen im Ring der Brille.",
    glassesTitle: "Brille", invert: "Wischrichtung umkehren", invertHint: "Wischen wechselt die Sportart; mit dieser Option läuft die Richtung andersherum.",
    controlsTitle: "Bedienung an der Brille", tapHelp: "Werte neu laden", swipeHelp: "Sport wechseln (Rad / Laufen)", holdHelp: "tut nichts", doubleHelp: "Ende (fragt nach)",
    tap: "Tippen", swipe: "Wischen", hold: "Halten", double: "2×",
    moreTitle: "Mehr", moreVersion: "Version", morePrivacy: "Die App speichert Sportart, Sprache, Maximalpuls und Bridge-Adresse nur auf dem Handy. Keine Garmin-Zugangsdaten. Der Verlauf lebt nur im Speicher, solange die App offen ist.",
    zone: "Zone", unitMin: "min",
  },
  en: {
    refresh: "refresh", sport: "sport", back: "back",
    cpSport: "SPORT", cpAvg: "AVG", cpZone: "ZONE", cpLive: "LIVE", cpHrMax: "MAX HR", cpHeart: "PULSE",
    kicker: "QUIETGLASS / SPORT", tabNow: "Now", tabLog: "History", tabSettings: "Settings",
    bannerDemo: "Sample data. Enter the address of your telemetry bridge under Settings.",
    bannerLive: "Live data from {source}.", bannerStale: "No fresh values for {age}.", bannerError: "Bridge not reachable: {error}",
    refreshNow: "Reload now", heroSide: "{sport}",
    logTime: "Time", logAvgHr: "Avg HR", logMaxHr: "Max HR", logAvgPower: "Avg power",
    stripTitle: "Last minutes", stripNone: "No values yet.",
    setupTitle: "First steps", setup1: "Enter the telemetry bridge address", setup2: "Pick the sport (or leave Automatic)", setup3: "Start the workout: the values go live",
    connectionTitle: "Connection", sportTitle: "Sport and heart rate", maxHr: "Maximum heart rate — {value} bpm", maxHrHint: "This gives the five heart-rate zones of the ring on the glasses.",
    glassesTitle: "Glasses", invert: "Reverse swipe direction", invertHint: "Swiping switches the sport; this option reverses the direction.",
    controlsTitle: "Controls on the glasses", tapHelp: "reload values", swipeHelp: "switch sport (bike / run)", holdHelp: "does nothing", doubleHelp: "exit (asks first)",
    tap: "Tap", swipe: "Swipe", hold: "Hold", double: "2×",
    moreTitle: "More", moreVersion: "Version", morePrivacy: "The app keeps sport, language, maximum heart rate and bridge address on the phone only. No Garmin credentials. The history lives in memory only, while the app is open.",
    zone: "Zone", unitMin: "min",
  },
  fr: {
    refresh: "actualiser", sport: "sport", back: "retour",
    cpSport: "SPORT", cpAvg: "Ø", cpZone: "ZONE", cpLive: "LIVE", cpHrMax: "FC MAX", cpHeart: "FC",
    kicker: "QUIETGLASS / SPORT", tabNow: "Direct", tabLog: "Historique", tabSettings: "Réglages",
    bannerDemo: "Données d'exemple. Saisis l'adresse de ta passerelle dans les réglages.",
    bannerLive: "Données en direct de {source}.", bannerStale: "Aucune valeur fraîche depuis {age}.", bannerError: "Passerelle injoignable : {error}",
    refreshNow: "Actualiser", heroSide: "{sport}",
    logTime: "Temps", logAvgHr: "FC moy.", logMaxHr: "FC max", logAvgPower: "Puiss. moy.",
    stripTitle: "Dernières minutes", stripNone: "Pas encore de valeurs.",
    setupTitle: "Premiers pas", setup1: "Saisis l'adresse de la passerelle", setup2: "Choisis le sport (ou laisse Automatique)", setup3: "Lance l'entraînement : les valeurs passent en direct",
    connectionTitle: "Connexion", sportTitle: "Sport et fréquence", maxHr: "Fréquence max — {value} bpm", maxHrHint: "Elle donne les cinq zones de l'anneau des lunettes.",
    glassesTitle: "Lunettes", invert: "Inverser le sens du balayage", invertHint: "Le balayage change de sport ; cette option inverse le sens.",
    controlsTitle: "Commandes des lunettes", tapHelp: "actualiser les valeurs", swipeHelp: "changer de sport (vélo / course)", holdHelp: "ne fait rien", doubleHelp: "fin (demande confirmation)",
    tap: "Toucher", swipe: "Glisser", hold: "Maintenir", double: "2×",
    moreTitle: "Plus", moreVersion: "Version", morePrivacy: "Sport, langue, fréquence max et adresse restent sur le téléphone. Aucun identifiant Garmin. L'historique n'existe qu'en mémoire, tant que l'app est ouverte.",
    zone: "Zone", unitMin: "min",
  },
  es: {
    refresh: "actualizar", sport: "deporte", back: "atrás",
    cpSport: "DEPORTE", cpAvg: "Ø", cpZone: "ZONA", cpLive: "VIVO", cpHrMax: "FC MÁX", cpHeart: "FC",
    kicker: "QUIETGLASS / SPORT", tabNow: "Ahora", tabLog: "Historial", tabSettings: "Ajustes",
    bannerDemo: "Datos de ejemplo. Introduce la dirección del puente en Ajustes.",
    bannerLive: "Datos en vivo de {source}.", bannerStale: "Sin valores recientes desde hace {age}.", bannerError: "Puente no disponible: {error}",
    refreshNow: "Actualizar ahora", heroSide: "{sport}",
    logTime: "Tiempo", logAvgHr: "FC media", logMaxHr: "FC máx", logAvgPower: "Pot. media",
    stripTitle: "Últimos minutos", stripNone: "Aún no hay valores.",
    setupTitle: "Primeros pasos", setup1: "Introduce la dirección del puente", setup2: "Elige el deporte (o deja Automático)", setup3: "Empieza el entreno: los valores pasan a vivo",
    connectionTitle: "Conexión", sportTitle: "Deporte y pulso", maxHr: "Pulso máximo — {value} bpm", maxHrHint: "De aquí salen las cinco zonas del anillo de las gafas.",
    glassesTitle: "Gafas", invert: "Invertir sentido del deslizamiento", invertHint: "Deslizar cambia de deporte; esta opción invierte el sentido.",
    controlsTitle: "Controles de las gafas", tapHelp: "actualizar valores", swipeHelp: "cambiar deporte (bici / carrera)", holdHelp: "no hace nada", doubleHelp: "salir (pregunta antes)",
    tap: "Tocar", swipe: "Deslizar", hold: "Mantener", double: "2×",
    moreTitle: "Más", moreVersion: "Versión", morePrivacy: "Deporte, idioma, pulso máximo y dirección del puente quedan solo en el teléfono. Sin credenciales Garmin. El historial solo vive en memoria mientras la app está abierta.",
    zone: "Zona", unitMin: "min",
  },
  it: {
    refresh: "aggiorna", sport: "sport", back: "indietro",
    cpSport: "SPORT", cpAvg: "Ø", cpZone: "ZONA", cpLive: "LIVE", cpHrMax: "FC MAX", cpHeart: "FC",
    kicker: "QUIETGLASS / SPORT", tabNow: "Adesso", tabLog: "Cronologia", tabSettings: "Impostazioni",
    bannerDemo: "Dati di esempio. Inserisci l'indirizzo del bridge nelle impostazioni.",
    bannerLive: "Dati live da {source}.", bannerStale: "Nessun valore recente da {age}.", bannerError: "Bridge non raggiungibile: {error}",
    refreshNow: "Aggiorna ora", heroSide: "{sport}",
    logTime: "Tempo", logAvgHr: "FC media", logMaxHr: "FC max", logAvgPower: "Pot. media",
    stripTitle: "Ultimi minuti", stripNone: "Ancora nessun valore.",
    setupTitle: "Primi passi", setup1: "Inserisci l'indirizzo del bridge", setup2: "Scegli lo sport (o lascia Automatico)", setup3: "Avvia l'allenamento: i valori diventano live",
    connectionTitle: "Connessione", sportTitle: "Sport e battito", maxHr: "Battito massimo — {value} bpm", maxHrHint: "Da qui nascono le cinque zone dell'anello degli occhiali.",
    glassesTitle: "Occhiali", invert: "Inverti il verso dello scorrimento", invertHint: "Scorrere cambia sport; questa opzione inverte il verso.",
    controlsTitle: "Comandi degli occhiali", tapHelp: "aggiorna i valori", swipeHelp: "cambia sport (bici / corsa)", holdHelp: "non fa nulla", doubleHelp: "fine (chiede conferma)",
    tap: "Tocca", swipe: "Scorri", hold: "Tieni", double: "2×",
    moreTitle: "Altro", moreVersion: "Versione", morePrivacy: "Sport, lingua, battito massimo e indirizzo restano solo sul telefono. Nessuna credenziale Garmin. La cronologia vive solo in memoria finché l'app è aperta.",
    zone: "Zona", unitMin: "min",
  },
};

/** `{name}` placeholders filled from `vars`. */
export function fill(text: string, vars: Record<string, string | number> = {}): string {
  return Object.entries(vars).reduce((out, [name, value]) => out.replaceAll(`{${name}}`, String(value)), text);
}
