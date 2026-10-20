/** What the glasses show: the start page (three entries), the run, the cockpit image, the task list. */
export type Screen = "start" | "run" | "cockpit" | "tasks";
export const SCREENS: readonly Screen[] = ["start", "run", "cockpit", "tasks"];

/** Where the user was on the glasses; a restart after a locked phone comes back there. */
export const UI_KEY = "quietglass.flowlist.ui.v1";

export interface SavedUi { readonly screen?: Screen; readonly startCursor?: number }

/** Tolerates missing or damaged storage: whatever is unusable is left out. */
export function parseUi(raw: string): SavedUi {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const screen = SCREENS.find((candidate) => candidate === value["screen"]);
    const cursor = value["startCursor"];
    return {
      ...(screen === undefined ? {} : { screen }),
      ...(typeof cursor === "number" && Number.isInteger(cursor) && cursor >= 0 && cursor <= 2 ? { startCursor: cursor } : {}),
    };
  } catch {
    return {};
  }
}
