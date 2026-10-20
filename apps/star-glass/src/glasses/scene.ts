import { cockpitModel, type CockpitModel } from "../cockpit/model";
import { buildControlView, buildStartView, type PageView, type ViewState } from "./views";

/** Everything on the glasses for one moment: a text page (start, control) or a cockpit picture. */
export type Scene =
  | { readonly kind: "text"; readonly view: PageView }
  | { readonly kind: "cockpit"; readonly model: CockpitModel };

export function sceneFor(state: ViewState): Scene {
  if (state.screen === "control") return { kind: "text", view: buildControlView(state) };
  if (state.screen === "start") return { kind: "text", view: buildStartView(state) };
  return { kind: "cockpit", model: cockpitModel(state) };
}
