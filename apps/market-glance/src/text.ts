import type { Locale } from "./i18n";

/**
 * Every word of the app in the five languages (glasses and phone). One table,
 * so a missing translation is a type error and the locale test can compare
 * the keys.
 */
export interface Text {
  // ---- glasses
  readonly title: string;
  readonly startOverview: string;
  readonly startPositions: string;
  readonly live: string;
  readonly demoWord: string;
  readonly staleWord: string;
  readonly offlineWord: string;
  readonly demoHint: string;
  readonly empty: string;
  readonly reload: string;
  readonly open: string;
  readonly pick: string;
  readonly pages: string;
  readonly dataAt: string;
  readonly staleAt: string;
  readonly total: string;
  readonly cellPositions: string;
  readonly cellPnl: string;
  readonly cellRealized: string;
  readonly cellTop: string;
  readonly cellFlop: string;
  readonly cellSource: string;
  readonly cellValue: string;
  readonly cellQuantity: string;
  readonly cellProvider: string;
  readonly cellPrice: string;
  readonly graphicTop: string;
  readonly graphicSince: string;
  // ---- phone
  readonly kicker: string;
  readonly tabNow: string;
  readonly tabPositions: string;
  readonly tabSettings: string;
  readonly bannerDemo: string;
  readonly bannerWaiting: string;
  readonly bannerStale: string;
  readonly bannerErrors: string;
  readonly bannerOk: string;
  readonly heroLabel: string;
  readonly heroSide: string;
  readonly statPnl: string;
  readonly statRealized: string;
  readonly statCount: string;
  readonly statSource: string;
  readonly unitUsd: string;
  readonly unitOpen: string;
  readonly refresh: string;
  readonly stripTitle: string;
  readonly positionsEmpty: string;
  readonly lastError: string;
  readonly realized: string;
  readonly setupTitle: string;
  readonly setup1: string;
  readonly setup2: string;
  readonly setup3: string;
  readonly setupDemo: string;
  readonly bridgeTitle: string;
  readonly bridgeSummary: string;
  readonly endpoint: string;
  readonly save: string;
  readonly glassesTitle: string;
  readonly invert: string;
  readonly invertHint: string;
  readonly languageTitle: string;
  readonly moreTitle: string;
  readonly about: string;
  readonly warning: string;
  readonly pillLive: string;
}

export const TEXT: Record<Locale, Text> = {
  de: {
    title: "Market Glance", startOverview: "Übersicht", startPositions: "Positionen", live: "live", demoWord: "Demo", staleWord: "veraltet", offlineWord: "offline",
    demoHint: "Demo · Verbindung am Handy einrichten", empty: "Keine offenen Positionen", reload: "neu", open: "öffnen", pick: "wählen", pages: "Seite",
    dataAt: "Stand {time}", staleAt: "Alt seit {time}", total: "GESAMT", cellPositions: "Positionen", cellPnl: "Gewinn", cellRealized: "Realisiert", cellTop: "Bester", cellFlop: "Letzter",
    cellSource: "Quelle", cellValue: "Wert", cellQuantity: "Menge", cellProvider: "Anbieter", cellPrice: "Kurs", graphicTop: "Wert", graphicSince: "seit {time}",
    kicker: "QUIETGLASS / FINANZEN", tabNow: "Jetzt", tabPositions: "Positionen", tabSettings: "Einstellungen",
    bannerDemo: "Demo-Daten. Ohne Markt-Bridge läuft die Demo.", bannerWaiting: "Warte auf die erste Antwort der Bridge …", bannerStale: "Daten sind veraltet ({age}). Läuft die Bridge noch?",
    bannerErrors: "Ein Anbieter antwortet nicht: {names}", bannerOk: "Alles aktuell. Nur Anzeige, keine Orders.",
    heroLabel: "Portfolio", heroSide: "{n} offen", statPnl: "Gewinn", statRealized: "Realisiert", statCount: "Positionen", statSource: "Quelle", unitUsd: "USD", unitOpen: "offen",
    refresh: "Neu laden", stripTitle: "Positionen", positionsEmpty: "Keine offenen Positionen", lastError: "Letzter Fehler", realized: "realisiert",
    setupTitle: "In drei Schritten", setup1: "Markt-Bridge auf dem Rechner starten", setup2: "Adresse unter Einstellungen eintragen", setup3: "Positionen erscheinen auf der Brille",
    setupDemo: "Ohne Bridge läuft die Demo.", bridgeTitle: "Verbindung", bridgeSummary: "Lokale Markt-Bridge", endpoint: "Adresse der Bridge", save: "Speichern",
    glassesTitle: "Brille", invert: "Wischrichtung umkehren", invertHint: "Nur nötig, wenn Wischen nach oben die Auswahl nach unten bewegt.",
    languageTitle: "Sprache", moreTitle: "Über Market Glance", about: "Read-only Positionen von Polymarket und Kalshi.", warning: "Nur Anzeige. Keine Orders, keine Kauf- oder Verkaufsgesten.", pillLive: "live",
  },
  en: {
    title: "Market Glance", startOverview: "Overview", startPositions: "Positions", live: "live", demoWord: "Demo", staleWord: "stale", offlineWord: "offline",
    demoHint: "Demo · set up the connection on the phone", empty: "No open positions", reload: "reload", open: "open", pick: "select", pages: "page",
    dataAt: "As of {time}", staleAt: "Old since {time}", total: "TOTAL", cellPositions: "Positions", cellPnl: "Profit", cellRealized: "Realized", cellTop: "Best", cellFlop: "Worst",
    cellSource: "Source", cellValue: "Value", cellQuantity: "Qty", cellProvider: "Provider", cellPrice: "Price", graphicTop: "Value", graphicSince: "since {time}",
    kicker: "QUIETGLASS / FINANCE", tabNow: "Now", tabPositions: "Positions", tabSettings: "Settings",
    bannerDemo: "Sample data. Without a market bridge the demo runs.", bannerWaiting: "Waiting for the bridge's first answer …", bannerStale: "Data is stale ({age}). Is the bridge still running?",
    bannerErrors: "A provider does not answer: {names}", bannerOk: "All up to date. Display only, no orders.",
    heroLabel: "Portfolio", heroSide: "{n} open", statPnl: "Profit", statRealized: "Realized", statCount: "Positions", statSource: "Source", unitUsd: "USD", unitOpen: "open",
    refresh: "Reload", stripTitle: "Positions", positionsEmpty: "No open positions", lastError: "Last error", realized: "realized",
    setupTitle: "In three steps", setup1: "Start the market bridge on your computer", setup2: "Enter its address under Settings", setup3: "Positions appear on the glasses",
    setupDemo: "Without a bridge the demo runs.", bridgeTitle: "Connection", bridgeSummary: "Local market bridge", endpoint: "Bridge address", save: "Save",
    glassesTitle: "Glasses", invert: "Invert swipe direction", invertHint: "Only needed if swiping up moves the selection down.",
    languageTitle: "Language", moreTitle: "About Market Glance", about: "Read-only positions from Polymarket and Kalshi.", warning: "Display only. No orders, buying, or selling gestures.", pillLive: "live",
  },
  fr: {
    title: "Market Glance", startOverview: "Aperçu", startPositions: "Positions", live: "live", demoWord: "Démo", staleWord: "périmé", offlineWord: "hors ligne",
    demoHint: "Démo · régler la connexion sur le téléphone", empty: "Aucune position ouverte", reload: "actualiser", open: "ouvrir", pick: "choisir", pages: "page",
    dataAt: "À {time}", staleAt: "Ancien depuis {time}", total: "TOTAL", cellPositions: "Positions", cellPnl: "Gain", cellRealized: "Réalisé", cellTop: "Meilleur", cellFlop: "Dernier",
    cellSource: "Source", cellValue: "Valeur", cellQuantity: "Qté", cellProvider: "Source", cellPrice: "Cours", graphicTop: "Valeur", graphicSince: "depuis {time}",
    kicker: "QUIETGLASS / FINANCE", tabNow: "Direct", tabPositions: "Positions", tabSettings: "Réglages",
    bannerDemo: "Données d'exemple. Sans passerelle, la démo tourne.", bannerWaiting: "En attente de la première réponse …", bannerStale: "Données périmées ({age}). La passerelle tourne-t-elle ?",
    bannerErrors: "Un fournisseur ne répond pas : {names}", bannerOk: "Tout est à jour. Affichage seul, pas d'ordres.",
    heroLabel: "Portefeuille", heroSide: "{n} ouvertes", statPnl: "Gain", statRealized: "Réalisé", statCount: "Positions", statSource: "Source", unitUsd: "USD", unitOpen: "ouvertes",
    refresh: "Actualiser", stripTitle: "Positions", positionsEmpty: "Aucune position ouverte", lastError: "Dernière erreur", realized: "réalisé",
    setupTitle: "En trois étapes", setup1: "Lancer la passerelle sur l'ordinateur", setup2: "Saisir son adresse dans Réglages", setup3: "Les positions s'affichent sur les lunettes",
    setupDemo: "Sans passerelle, la démo tourne.", bridgeTitle: "Connexion", bridgeSummary: "Passerelle locale", endpoint: "Adresse de la passerelle", save: "Enregistrer",
    glassesTitle: "Lunettes", invert: "Inverser le sens du glissement", invertHint: "Utile seulement si glisser vers le haut descend la sélection.",
    languageTitle: "Langue", moreTitle: "À propos de Market Glance", about: "Positions en lecture seule de Polymarket et Kalshi.", warning: "Affichage uniquement. Aucun ordre ni geste d'achat ou de vente.", pillLive: "live",
  },
  es: {
    title: "Market Glance", startOverview: "Resumen", startPositions: "Posiciones", live: "en vivo", demoWord: "Demo", staleWord: "antiguo", offlineWord: "sin conexión",
    demoHint: "Demo · configura la conexión en el móvil", empty: "Sin posiciones abiertas", reload: "actualizar", open: "abrir", pick: "elegir", pages: "página",
    dataAt: "A las {time}", staleAt: "Antiguo desde {time}", total: "TOTAL", cellPositions: "Posiciones", cellPnl: "Ganancia", cellRealized: "Realizado", cellTop: "Mejor", cellFlop: "Peor",
    cellSource: "Fuente", cellValue: "Valor", cellQuantity: "Cant.", cellProvider: "Proveedor", cellPrice: "Precio", graphicTop: "Valor", graphicSince: "desde {time}",
    kicker: "QUIETGLASS / FINANZAS", tabNow: "Ahora", tabPositions: "Posiciones", tabSettings: "Ajustes",
    bannerDemo: "Datos de ejemplo. Sin puente, funciona la demo.", bannerWaiting: "Esperando la primera respuesta del puente …", bannerStale: "Datos antiguos ({age}). ¿Sigue activo el puente?",
    bannerErrors: "Un proveedor no responde: {names}", bannerOk: "Todo al día. Solo vista, sin órdenes.",
    heroLabel: "Cartera", heroSide: "{n} abiertas", statPnl: "Ganancia", statRealized: "Realizado", statCount: "Posiciones", statSource: "Fuente", unitUsd: "USD", unitOpen: "abiertas",
    refresh: "Actualizar", stripTitle: "Posiciones", positionsEmpty: "Sin posiciones abiertas", lastError: "Último error", realized: "realizado",
    setupTitle: "En tres pasos", setup1: "Inicia el puente en el ordenador", setup2: "Introduce su dirección en Ajustes", setup3: "Las posiciones aparecen en las gafas",
    setupDemo: "Sin puente, funciona la demo.", bridgeTitle: "Conexión", bridgeSummary: "Puente local", endpoint: "Dirección del puente", save: "Guardar",
    glassesTitle: "Gafas", invert: "Invertir sentido de deslizar", invertHint: "Solo si deslizar hacia arriba baja la selección.",
    languageTitle: "Idioma", moreTitle: "Acerca de Market Glance", about: "Posiciones de solo lectura de Polymarket y Kalshi.", warning: "Solo visualización. Sin órdenes ni gestos de compra o venta.", pillLive: "en vivo",
  },
  it: {
    title: "Market Glance", startOverview: "Panoramica", startPositions: "Posizioni", live: "live", demoWord: "Demo", staleWord: "vecchio", offlineWord: "offline",
    demoHint: "Demo · imposta la connessione sul telefono", empty: "Nessuna posizione aperta", reload: "aggiorna", open: "apri", pick: "scegli", pages: "pagina",
    dataAt: "Alle {time}", staleAt: "Vecchio da {time}", total: "TOTALE", cellPositions: "Posizioni", cellPnl: "Guadagno", cellRealized: "Realizzato", cellTop: "Migliore", cellFlop: "Peggiore",
    cellSource: "Fonte", cellValue: "Valore", cellQuantity: "Qtà", cellProvider: "Fornitore", cellPrice: "Prezzo", graphicTop: "Valore", graphicSince: "da {time}",
    kicker: "QUIETGLASS / FINANZA", tabNow: "Ora", tabPositions: "Posizioni", tabSettings: "Impostazioni",
    bannerDemo: "Dati di esempio. Senza bridge gira la demo.", bannerWaiting: "In attesa della prima risposta del bridge …", bannerStale: "Dati vecchi ({age}). Il bridge è ancora attivo?",
    bannerErrors: "Un fornitore non risponde: {names}", bannerOk: "Tutto aggiornato. Solo vista, nessun ordine.",
    heroLabel: "Portafoglio", heroSide: "{n} aperte", statPnl: "Guadagno", statRealized: "Realizzato", statCount: "Posizioni", statSource: "Fonte", unitUsd: "USD", unitOpen: "aperte",
    refresh: "Aggiorna", stripTitle: "Posizioni", positionsEmpty: "Nessuna posizione aperta", lastError: "Ultimo errore", realized: "realizzato",
    setupTitle: "In tre passi", setup1: "Avvia il bridge sul computer", setup2: "Inserisci il suo indirizzo in Impostazioni", setup3: "Le posizioni compaiono sugli occhiali",
    setupDemo: "Senza bridge gira la demo.", bridgeTitle: "Connessione", bridgeSummary: "Bridge locale", endpoint: "Indirizzo del bridge", save: "Salva",
    glassesTitle: "Occhiali", invert: "Inverti direzione di scorrimento", invertHint: "Serve solo se scorrere in alto sposta la selezione in basso.",
    languageTitle: "Lingua", moreTitle: "Informazioni su Market Glance", about: "Posizioni in sola lettura da Polymarket e Kalshi.", warning: "Solo visualizzazione. Nessun ordine o gesto di acquisto/vendita.", pillLive: "live",
  },
};

export type TextKey = keyof Text;

/** One word of the chosen language; `{name}` placeholders are filled from `vars`. */
export function t(locale: Locale, key: TextKey, vars: Record<string, string | number> = {}): string {
  return TEXT[locale][key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));
}
