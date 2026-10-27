/**
 * What the glasses show (QUS v1, calm): a start screen with two entries, and
 * for test B a quiet run view (`Test B · ● rec`), one hint line at the bottom.
 * Pure: state in, three texts out.
 */

export type Screen =
  | { readonly kind: "start"; readonly sel: 0 | 1 }
  | { readonly kind: "infoA"; readonly lastA: string | null }
  | { readonly kind: "recording"; readonly secondsLeft: number; readonly chunks: number }
  | { readonly kind: "working"; readonly line: string }
  | { readonly kind: "result"; readonly ok: boolean; readonly lines: readonly string[] };

export interface PageView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

export interface ViewContext {
  readonly lang: string;
  readonly model: string;
}

export function viewFor(screen: Screen, ctx: ViewContext): PageView {
  switch (screen.kind) {
    case "start":
      return {
        header: "Speech Probe",
        body: [
          `${screen.sel === 0 ? "●" : "○"} Test A · phone speech`,
          "    platform recognition, runs on the phone",
          "",
          `${screen.sel === 1 ? "●" : "○"} Test B · Whisper 5 s`,
          `    glasses mic · ${ctx.model} · ${ctx.lang}`,
        ],
        footer: "Swipe choose · tap start · 2× exit",
      };
    case "infoA":
      return {
        header: "Test A · phone",
        body: [
          "Runs on the phone page:",
          "open Speech Probe in the Even app",
          "and press Start in card A.",
          "",
          screen.lastA ?? "No run yet.",
        ],
        footer: "2× back",
      };
    case "recording":
      return {
        header: "Test B · ● rec",
        body: ["Speak now.", "", `${screen.secondsLeft} s left`, screen.chunks > 0 ? "" : "waiting for audio…"],
        footer: "2× cancel",
      };
    case "working":
      return { header: "Test B · transcribing…", body: [screen.line], footer: "please wait · 2× back" };
    case "result":
      return { header: screen.ok ? "Test B · done" : "Test B · failed", body: screen.lines, footer: "Tap again · 2× back" };
  }
}
