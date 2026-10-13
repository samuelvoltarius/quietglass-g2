/**
 * Place search: the answer of MOTIS' `/api/v1/geocode`, reduced to what the
 * phone page lists. The same Transitous origin that serves the timetable
 * answers it, so no second service (and no second network permission) is
 * involved.
 */

export interface GeoResult {
  readonly name: string;
  /** "5020 Salzburg, AT" — enough to tell two Hauptbahnhöfe apart. */
  readonly detail: string;
  readonly kind: "stop" | "address" | "place";
  readonly lat: number;
  readonly lon: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function parseGeocode(raw: unknown, limit = 8): readonly GeoResult[] {
  const found: GeoResult[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const record = asRecord(entry);
    const name = typeof record["name"] === "string" ? record["name"].trim() : "";
    const lat = record["lat"];
    const lon = record["lon"];
    if (!name || typeof lat !== "number" || typeof lon !== "number") continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const key = `${name}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const areas = Array.isArray(record["areas"]) ? record["areas"].map(asRecord) : [];
    const town = areas.find((area) => area["default"] === true)?.["name"];
    const zip = typeof record["zip"] === "string" ? record["zip"] : "";
    const country = typeof record["country"] === "string" ? record["country"] : "";
    const place = [zip, typeof town === "string" ? town : ""].filter(Boolean).join(" ");
    const detail = [place, country].filter(Boolean).join(", ");

    const type = record["type"];
    found.push({
      name, detail, lat, lon,
      kind: type === "STOP" ? "stop" : type === "ADDRESS" ? "address" : "place",
    });
    if (found.length >= limit) break;
  }
  return found;
}
