import type { Gesture, InputSource } from "../input/gestures";
import { SCREENS, type HubGesture, type Screen } from "./model";

/**
 * Map the shared gesture vocabulary onto the hub's page language. The R1 ring
 * (event source 2) swipes and taps like the glasses, but its double tap opens
 * the page picker instead of going back / exiting.
 */
export function hubGesture(gesture: Gesture, source: InputSource = "unknown"): HubGesture | null {
  switch (gesture) {
    case "click": return "click";
    case "doubleClick": return source === "ring" ? "ringDoubleClick" : "doubleClick";
    case "scrollUp": return "scrollUp";
    case "scrollDown": return "scrollDown";
    case "longPress": return "longPress";
    case "longPressRelease": return "longPressRelease";
    default: return null;
  }
}

/** Opening from the glasses launcher goes straight to the Overview; the phone app menu resumes. */
export function startScreen(source: "appMenu" | "glassesMenu" | null, saved: Screen | null): Screen {
  if (source === "glassesMenu") return "root";
  return saved !== null && SCREENS.includes(saved) ? saved : "root";
}

