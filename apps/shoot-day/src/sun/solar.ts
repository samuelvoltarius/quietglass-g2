/**
 * Sun (and a little moon) for photographers — offline, pure, no network.
 *
 * Sun: the NOAA solar calculator's algorithm (J. Meeus, "Astronomical
 * Algorithms"): mean longitude and anomaly, equation of centre, apparent
 * longitude, declination and the equation of time; events are found from
 * the hour angle at a given elevation and refined twice at the event time.
 * Accurate to well under a minute between the polar circles. Moon: the
 * low-precision SunCalc model, enough for its phase.
 *
 * Times are plain epoch milliseconds; turning them into a wall clock is the
 * caller's job (the phone's time zone).
 */

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

interface SolarState {
  /** Declination (radians). */
  readonly dec: number;
  /** Equation of time (minutes). */
  readonly eot: number;
}

function solarState(ms: number): SolarState {
  const t = (ms / DAY_MS + 2440587.5 - 2451545) / 36525;
  const l0 = normDeg(280.46646 + t * (36000.76983 + t * 0.0003032));
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const centre = Math.sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t))
    + Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * t)
    + Math.sin(3 * m * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + centre - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const dec = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));
  const y = Math.tan((eps * RAD) / 2) ** 2;
  const eot = (4 / RAD) * (
    y * Math.sin(2 * l0 * RAD)
    - 2 * e * Math.sin(m * RAD)
    + 4 * e * y * Math.sin(m * RAD) * Math.cos(2 * l0 * RAD)
    - 0.5 * y * y * Math.sin(4 * l0 * RAD)
    - 1.25 * e * e * Math.sin(2 * m * RAD)
  );
  return { dec, eot };
}

/** Where the sun is: azimuth clockwise from north (0…360°), elevation above the horizon (geometric, °). */
export interface SunPosition {
  readonly azimuth: number;
  readonly elevation: number;
}

export function sunPosition(ms: number, latitude: number, longitude: number): SunPosition {
  const { dec, eot } = solarState(ms);
  const phi = latitude * RAD;
  const utcMinutes = (((ms % DAY_MS) + DAY_MS) % DAY_MS) / MINUTE_MS;
  const trueSolarMinutes = utcMinutes + eot + 4 * longitude;
  const h = (trueSolarMinutes / 4 - 180) * RAD;
  const elevation = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h));
  // Measured from south, positive towards west; turned into a compass bearing.
  const fromSouth = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  return { azimuth: normDeg(fromSouth / RAD + 180), elevation: elevation / RAD };
}

// ---- times of the day --------------------------------------------------------

/** Elevations (°) the day is cut at. Sunrise/sunset include refraction and the sun's radius. */
export const ANGLES = {
  sunrise: -0.833,
  goldenHigh: 6,
  goldenLow: -4,
  blueLow: -6,
} as const;

/** One stretch of light; either end may be missing (the sun never gets there that day). */
export interface Span {
  readonly start: number | null;
  readonly end: number | null;
}

export interface SunTimes {
  /** The sun at its highest. */
  readonly noon: number;
  /** Elevation at solar noon (°). */
  readonly noonElevation: number;
  readonly sunrise: number | null;
  readonly sunset: number | null;
  /** −6° … −4° before sunrise. */
  readonly blueMorning: Span;
  /** −4° … +6° around sunrise. */
  readonly goldenMorning: Span;
  /** +6° … −4° around sunset. */
  readonly goldenEvening: Span;
  /** −4° … −6° after sunset. */
  readonly blueEvening: Span;
}

/** Solar noon nearest to `near` at this longitude. */
function solarNoonNear(near: number, longitude: number, eot: number): number {
  const midnight = Math.floor(near / DAY_MS) * DAY_MS;
  let noon = midnight + (720 - 4 * longitude - eot) * MINUTE_MS;
  if (noon - near > DAY_MS / 2) noon -= DAY_MS;
  if (near - noon > DAY_MS / 2) noon += DAY_MS;
  return noon;
}

/**
 * Sun times for the day around `ms` at the given place. Pass a moment around
 * local noon (`localNoon`) so the right day is picked whatever the time zone.
 * Missing times (polar day or night) are null.
 */
export function sunTimes(ms: number, latitude: number, longitude: number): SunTimes {
  const phi = latitude * RAD;
  let noon = ms;
  for (let pass = 0; pass < 3; pass += 1) noon = solarNoonNear(ms, longitude, solarState(noon).eot);

  /** The moment the sun crosses `degrees` before (rising) or after noon; null when it never does. */
  const cross = (degrees: number, rising: boolean): number | null => {
    let at = noon;
    for (let pass = 0; pass < 3; pass += 1) {
      const { dec, eot } = solarState(at);
      const cos = (Math.sin(degrees * RAD) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
      if (cos < -1 || cos > 1) return null;
      const hourAngle = Math.acos(cos) / RAD;
      const dayNoon = solarNoonNear(noon, longitude, eot);
      at = dayNoon + (rising ? -4 : 4) * hourAngle * MINUTE_MS;
    }
    return at;
  };

  const sunrise = cross(ANGLES.sunrise, true);
  const sunset = cross(ANGLES.sunrise, false);
  return {
    noon,
    noonElevation: sunPosition(noon, latitude, longitude).elevation,
    sunrise,
    sunset,
    blueMorning: { start: cross(ANGLES.blueLow, true), end: cross(ANGLES.goldenLow, true) },
    goldenMorning: { start: cross(ANGLES.goldenLow, true), end: cross(ANGLES.goldenHigh, true) },
    goldenEvening: { start: cross(ANGLES.goldenHigh, false), end: cross(ANGLES.goldenLow, false) },
    blueEvening: { start: cross(ANGLES.goldenLow, false), end: cross(ANGLES.blueLow, false) },
  };
}

/** Local noon of the calendar day of `ms`, in the phone's time zone. */
export function localNoon(ms: number): number {
  const day = new Date(ms);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12, 0, 0, 0).getTime();
}

// ---- moon (phase only: cheap and enough to know whether nights are dark) -----

const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;
const toDays = (ms: number): number => ms / DAY_MS - 0.5 + J1970 - J2000;
const rightAscension = (l: number, b: number): number =>
  Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY), Math.cos(l));
const declination = (l: number, b: number): number =>
  Math.asin(Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l));

function sunCoords(d: number): { dec: number; ra: number } {
  const m = RAD * (357.5291 + 0.98560028 * d);
  const centre = RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m));
  const l = m + centre + RAD * 102.9372 + Math.PI;
  return { dec: declination(l, 0), ra: rightAscension(l, 0) };
}

export interface MoonPhase {
  /** 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter. */
  readonly phase: number;
  /** Lit fraction 0…1. */
  readonly fraction: number;
}

export function moonPhase(ms: number): MoonPhase {
  const d = toDays(ms);
  const s = sunCoords(d);
  // Moon coordinates (low precision).
  const lng = RAD * (218.316 + 13.176396 * d);
  const mean = RAD * (134.963 + 13.064993 * d);
  const f = RAD * (93.272 + 13.22935 * d);
  const lon = lng + RAD * 6.289 * Math.sin(mean);
  const lat = RAD * 5.128 * Math.sin(f);
  const dist = 385001 - 20905 * Math.cos(mean);
  const mDec = declination(lon, lat);
  const mRa = rightAscension(lon, lat);
  const sdist = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(mDec) + Math.cos(s.dec) * Math.cos(mDec) * Math.cos(s.ra - mRa));
  const inc = Math.atan2(sdist * Math.sin(phi), dist - sdist * Math.cos(phi));
  const angle = Math.atan2(
    Math.cos(s.dec) * Math.sin(s.ra - mRa),
    Math.sin(s.dec) * Math.cos(mDec) - Math.cos(s.dec) * Math.sin(mDec) * Math.cos(s.ra - mRa),
  );
  return {
    fraction: (1 + Math.cos(inc)) / 2,
    phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI,
  };
}

/** One of eight phase names: new, waxingCrescent, firstQuarter, waxingGibbous, full, waningGibbous, lastQuarter, waningCrescent. */
export function moonPhaseName(phase: number): string {
  const names = ["new", "waxingCrescent", "firstQuarter", "waxingGibbous", "full", "waningGibbous", "lastQuarter", "waningCrescent"];
  return names[Math.round(normUnit(phase) * 8) % 8]!;
}

// ---- compass -----------------------------------------------------------------

const POINTS = {
  de: ["N", "NNO", "NO", "ONO", "O", "OSO", "SO", "SSO", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"],
  en: ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"],
} as const;

/** 16-point compass letters for a bearing; German uses O for east. */
export function compassPoint(azimuth: number, locale: "de" | "en"): string {
  return POINTS[locale][Math.round(normDeg(azimuth) / 22.5) % 16]!;
}

export function normDeg(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

function normUnit(value: number): number {
  return ((value % 1) + 1) % 1;
}
