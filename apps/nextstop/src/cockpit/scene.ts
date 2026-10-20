import type { Locale } from "../i18n";
import { t } from "../messages";
import { ft } from "../footer";
import { messageScene } from "../glasses/board";
import type { Scene } from "../route/scene";
import { COCKPIT_IMAGES } from "../glasses/layout";
import { encodeGreyPng } from "../screen/png";
import { autoBackend, type TextBackend } from "../screen/text";
import type { Departure, Stop } from "../transit/types";
import { rideStopName } from "../glasses/view";
import { composeTiles, type ComposedTiles } from "./compose";
import { boardModel, type CockpitModel } from "./model";

/**
 * The departures page as a scene: the cockpit picture cut into four tiles.
 * Each tile's key is its pixel key, so a redraw sends exactly the tiles whose
 * pixels changed (the clock only the one at the top right).
 */

let backend: TextBackend | null = null;
/** The text backend of the device (canvas in the WebView, pixel font in tests); made once. */
export function textBackend(): TextBackend {
  backend ??= autoBackend();
  return backend;
}

/** A scene of four composed tiles; `hint` stands in the view so tests and the diff can read it. */
export function tilesScene(hint: string, composed: ComposedTiles): Scene {
  return {
    view: { header: "", body: [], footer: hint },
    kind: "cockpit",
    animated: false,
    images: COCKPIT_IMAGES.map((spec, index) => ({
      id: spec.id,
      key: `tile:${composed.keys[index]}`,
      render: async () => encodeGreyPng(composed.tiles[index]!),
    })),
  };
}

export function cockpitScene(model: CockpitModel, text: TextBackend = textBackend()): Scene {
  return tilesScene(model.hint, composeTiles(model, text));
}

/**
 * The departure board: the selected departure as the cockpit (QUS v1). An empty
 * board is a message page. Swiping moves the selection, a tap follows it.
 */
export function boardScene(
  stop: Stop, departures: readonly Departure[], metresAway: number | null, locale: Locale, selected: number, now: Date,
): Scene {
  if (departures.length === 0) {
    const place = rideStopName(stop.name, 30);
    return messageScene(t(locale, "g.emptyBoardTitle"), `${place} · ${t(locale, "g.emptyBoardHint")}`, ft(locale, "back", { hold: "goal" }), "--");
  }
  return cockpitScene(boardModel({ stop, departures, selected, metresAway, now, locale }));
}
