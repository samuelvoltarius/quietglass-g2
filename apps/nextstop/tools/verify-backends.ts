/**
 * Runs both backends against the live services.
 *
 * Kept out of the test suite on purpose: it needs a network, and both
 * services answer differently at three in the morning than at rush hour. It
 * exists so that "the adapters work" is something that has been observed
 * rather than assumed.
 *
 *   npx vite-node tools/verify-backends.ts
 */
import { HafasBackend } from "../src/transit/hafas";
import { MotisBackend } from "../src/transit/motis";
import { trackRide } from "../src/ride/tracker";
import type { TransitBackend } from "../src/transit/types";
import { delayMinutes } from "../src/transit/types";

// Mirabellplatz, Salzburg — a stop with many stands, which is the awkward case.
const LAT = 47.8060;
const LON = 13.0430;

async function check(backend: TransitBackend): Promise<void> {
  console.log(`\n=== ${backend.label} ===`);

  const stops = await backend.nearbyStops(LAT, LON, 3);
  console.log(`Haltestellen in der Nähe: ${stops.length}`);
  for (const stop of stops) console.log(`  ${stop.name}  [${stop.id}]`);

  const first = stops[0];
  if (!first) {
    console.log("  keine Haltestelle gefunden — Abbruch");
    return;
  }

  const departures = await backend.departures(first.id, 8);
  const live = departures.filter((d) => d.source === "realtime").length;
  console.log(`\nAbfahrten an "${first.name}": ${departures.length}`
    + `  (davon Echtzeit: ${live})`);
  for (const departure of departures.slice(0, 6)) {
    const delay = delayMinutes(departure);
    const mark = departure.source === "realtime"
      ? (delay === 0 ? "pünktlich" : `${delay > 0 ? "+" : ""}${delay} min`)
      : "Fahrplan";
    console.log(`  ${departure.line.padEnd(9)} ${departure.headsign.slice(0, 24).padEnd(24)}`
      + ` ${String(departure.inMinutes).padStart(3)} min  ${mark}`
      + (departure.track ? `  Steig ${departure.track}` : ""));
  }

  const target = departures[0];
  if (!target) return;

  const ride = await backend.ride(target.tripId);
  if (!ride) {
    console.log("\n  Fahrtverlauf: nicht verfügbar");
    return;
  }
  console.log(`\nFahrtverlauf ${ride.line} -> ${ride.headsign}: ${ride.stops.length} Halte`);
  for (const stop of ride.stops.slice(0, 4)) {
    console.log(`  ${stop.stop.name.slice(0, 32).padEnd(32)}`
      + ` ${stop.expected.toTimeString().slice(0, 5)}  ${stop.source}`);
  }

  // The whole point of the app: standing at the first stop, what comes next.
  const boarding = ride.stops[0];
  if (boarding) {
    const progress = trackRide(ride, new Date(), {
      lat: boarding.stop.lat, lon: boarding.stop.lon,
    });
    console.log(`\n  Verfolgung ab Einstieg: nächster Halt "${progress?.next.stop.name}"`
      + ` (Quelle: ${progress?.basis}, noch ${progress?.upcoming.length} danach)`);
  }
}

// Declared rather than pulled in via @types/node: this one script is the only
// thing in the app that runs outside a browser, and a Node type dependency
// would otherwise be installed for every build of the app itself.
declare const process: { argv: string[] };

const which = process.argv[2] ?? "both";

if (which === "oebb" || which === "both") {
  // Straight to ÖBB: Node has no same-origin rule, so the proxy the glasses
  // need is not involved here.
  await check(new HafasBackend({ baseUrl: "https://fahrplan.oebb.at/bin/mgate.exe" }))
    .catch((error: unknown) => console.error("ÖBB fehlgeschlagen:", error));
}
if (which === "motis" || which === "both") {
  await check(new MotisBackend()).catch((error: unknown) =>
    console.error("Transitous fehlgeschlagen:", error));
}
