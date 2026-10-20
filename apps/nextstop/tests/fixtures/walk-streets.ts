import valhalla from "./valhalla-walk.json";
import { parseWalkRoute, type LatLon } from "../../src/route/walk";
import type { RoadClass } from "../../src/map/streets";

/**
 * A fixed, offline stand-in for an Overpass answer, for the map tests and the
 * preview pictures (no network, always the same).
 *
 * It is SYNTHETIC, not OpenStreetMap data: the real route of the Valhalla
 * fixture (valhalla-walk.json) is taken as one residential street, with side
 * streets across it every ~90 m, two parallel streets 70 m to either side, one
 * major road crossing at an angle and a few footpaths. Built in the shape
 * Overpass answers in (ways with geometry, a count element after each class),
 * so reading it goes through the same parser as the real thing.
 */

export const WALK_ROUTE = parseWalkRoute(valhalla)!;

const M_LAT = 110_540;
const M_LON = 111_320;

interface Way { readonly points: readonly LatLon[]; readonly name?: string | undefined }

/** Names of the streets of the fixture (invented positions, real Salzburg street names). */
export const ROUTE_STREETS = ["Vogelweiderstraße", "Sterneckstraße", "Rainerstraße"] as const;
const SIDE_NAMES = ["Mirabellplatz", "Paris-Lodron-Straße", "Dreifaltigkeitsgasse", "Wolf-Dietrich-Straße", "Bergstraße", "Schallmooser Hauptstraße"];

function offset(origin: LatLon, east: number, north: number): LatLon {
  return { lat: origin.lat + north / M_LAT, lon: origin.lon + east / (M_LON * Math.cos((origin.lat * Math.PI) / 180)) };
}

/** The route shape reduced to about every 40 m, so a parallel street does not copy every kink. */
function simplified(shape: readonly LatLon[]): LatLon[] {
  const out: LatLon[] = [shape[0]!];
  for (const point of shape) {
    const last = out[out.length - 1]!;
    const east = (point.lon - last.lon) * M_LON * Math.cos((last.lat * Math.PI) / 180);
    const north = (point.lat - last.lat) * M_LAT;
    if (Math.hypot(east, north) >= 40) out.push(point);
  }
  out.push(shape[shape.length - 1]!);
  return out;
}

function parallel(line: readonly LatLon[], metres: number): LatLon[] {
  return line.map((point, index) => {
    const a = line[Math.max(0, index - 1)]!; const b = line[Math.min(line.length - 1, index + 1)]!;
    const east = (b.lon - a.lon) * M_LON * Math.cos((a.lat * Math.PI) / 180);
    const north = (b.lat - a.lat) * M_LAT;
    const length = Math.hypot(east, north) || 1;
    // The left-hand normal of the direction of travel.
    return offset(point, (-north / length) * metres, (east / length) * metres);
  });
}

function ways(): Record<RoadClass, Way[]> {
  const shape = WALK_ROUTE.shape;
  const line = simplified(shape);
  const third = Math.floor(shape.length / 3);
  const minor: Way[] = [
    { points: shape.slice(0, third + 1), name: ROUTE_STREETS[0] },
    { points: shape.slice(third, 2 * third + 1), name: ROUTE_STREETS[1] },
    { points: shape.slice(2 * third), name: ROUTE_STREETS[2] },
    { points: parallel(line, 70), name: "Schwarzstraße" },
    { points: parallel(line, -70), name: "Linzer Gasse" },
  ];
  // Side streets across the route, every ~90 m, alternating their lean.
  let walked = 0;
  line.forEach((point, index) => {
    if (index === 0) return;
    const before = line[index - 1]!;
    walked += Math.hypot((point.lon - before.lon) * M_LON * Math.cos((point.lat * Math.PI) / 180), (point.lat - before.lat) * M_LAT);
    if (index % 2 === 0) {
      const lean = index % 4 === 0 ? 12 : -12;
      minor.push({ points: [offset(point, -150 + lean, -150), offset(point, 0, 0), offset(point, 150 + lean, 150)], name: SIDE_NAMES[(index / 2) % SIDE_NAMES.length] });
    }
  });
  void walked;
  const middle = shape[Math.floor(shape.length / 2)]!;
  const major: Way[] = [{ points: [offset(middle, -420, -260), offset(middle, -120, -60), offset(middle, 150, 80), offset(middle, 440, 300)], name: "Franz-Josef-Straße" }];
  const path: Way[] = [
    { points: [offset(middle, -40, 60), offset(middle, -90, 130), offset(middle, -100, 200)] },
    { points: [offset(shape[1]!, 30, 20), offset(shape[1]!, 90, 90)] },
    { points: [offset(shape[shape.length - 2]!, -20, -30), offset(shape[shape.length - 2]!, -80, -100), offset(shape[shape.length - 2]!, -130, -110)] },
  ];
  return { major, minor, path };
}

/** The answer of the query for the classes major, minor, path (in this order), as Overpass writes it. */
export function walkStreetsAnswer(): { elements: unknown[] } {
  const all = ways();
  const elements: unknown[] = [];
  let id = 1;
  for (const cls of ["major", "minor", "path"] as const) {
    for (const way of all[cls]) {
      elements.push({ type: "way", id: id++, ...(way.name && cls !== "path" ? { tags: { name: way.name } } : {}), geometry: way.points.map((p) => ({ lat: p.lat, lon: p.lon })) });
    }
    elements.push({ type: "count", id: 0, tags: { ways: String(all[cls].length) } });
  }
  return { elements };
}
