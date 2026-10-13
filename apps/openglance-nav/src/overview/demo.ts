import type { LatLng } from "../geo/geometry";
import type { Street } from "./streets";

/**
 * Made-up streets with real-sounding Salzburg names around a route, for the
 * demo and the simulator (which have no Overpass): the route's own legs under
 * the names of its manoeuvres, a few cross streets and two parallel ones. Only
 * used with the mock router; nothing here is fetched or sent anywhere.
 */
const CROSS = ["Getreidegasse", "Franz-Josef-Kai", "Müllner Hauptstraße", "Imbergstraße", "Schwarzstraße"];
const PARALLEL = ["Griesgasse", "Bürgerspitalplatz"];

export function demoStreets(route: readonly LatLng[], legs: ReadonlyArray<{ from: number; name: string }>): Street[] {
  if (route.length < 3) return [];
  const streets: Street[] = [];
  legs.forEach((leg, i) => {
    const to = legs[i + 1]?.from ?? route.length - 1;
    const points = route.slice(leg.from, to + 1);
    if (points.length >= 2) streets.push({ cls: "major", points: [...points], name: leg.name });
  });
  const mPerLat = 110_540;
  const at = (p: LatLng, north: number, east: number): LatLng => ({ lat: p.lat + north / mPerLat, lon: p.lon + east / (111_320 * Math.cos((p.lat * Math.PI) / 180)) });
  // Cross streets at fixed fractions of the route, square to it.
  [0.12, 0.3, 0.5, 0.72, 0.9].forEach((fraction, i) => {
    const index = Math.min(route.length - 2, Math.max(1, Math.round(fraction * (route.length - 1))));
    const a = route[index - 1]!, b = route[index + 1]!;
    const dn = (b.lat - a.lat) * mPerLat, de = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
    const len = Math.hypot(dn, de) || 1;
    const nn = -de / len, ne = dn / len; // left-hand normal
    const p = route[index]!;
    streets.push({ cls: i % 2 === 0 ? "minor" : "major", name: CROSS[i % CROSS.length]!, points: [at(p, nn * -420, ne * -420), p, at(p, nn * 420, ne * 420)] });
  });
  // Two streets running alongside the route's first leg.
  PARALLEL.forEach((name, i) => {
    const side = i === 0 ? -260 : 300;
    const leg = legs[1] ? route.slice(0, legs[1].from + 4) : route;
    const a = leg[0]!, b = leg[leg.length - 1]!;
    const dn = (b.lat - a.lat) * mPerLat, de = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
    const len = Math.hypot(dn, de) || 1;
    const nn = -de / len, ne = dn / len;
    streets.push({ cls: "minor", name, points: leg.filter((_, k) => k % 3 === 0 || k === leg.length - 1).map((p) => at(p, nn * side, ne * side)) });
  });
  return streets;
}
