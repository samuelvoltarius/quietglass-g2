import type { Locale } from "../i18n";
import { t } from "../messages";
import type { VoiceReply } from "../stt/voice";

/**
 * 0.8.0 "Meine Stimme" sheet on the glasses (side menu "Meine Stimme lernen" /
 * "Meine Stimme löschen"): what it says in each step. The rows always fit one
 * page (BODY_ROWS) including the sheet's end row.
 */
export type VoiceSheet =
  | { readonly kind: "connecting" | "saving" | "deleting" | "noServer" | "micDenied" }
  | { readonly kind: "reading"; readonly until: number }
  | { readonly kind: "result"; readonly reply: VoiceReply };

/** The paragraph to read (five rows, ~40 words = ~15 s at a calm pace). */
export const READ_KEYS = ["g.v.t1", "g.v.t2", "g.v.t3", "g.v.t4", "g.v.t5"] as const;

export function voiceSheetRows(sheet: VoiceSheet, locale: Locale, now: number): string[] {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  switch (sheet.kind) {
    case "connecting": return [x("g.v.connecting")];
    case "saving": return [x("g.v.saving")];
    case "deleting": return [x("g.v.deleting")];
    case "noServer": return [x("g.v.noServer")];
    case "micDenied": return [x("g.v.mic"), x("g.v.notSaved")];
    case "reading": {
      const left = Math.max(0, Math.ceil((sheet.until - now) / 1000));
      return [x("g.v.read", { s: left }), ...READ_KEYS.map((key) => x(key))];
    }
    case "result": {
      const reply = sheet.reply;
      if (reply.action === "delete") {
        if (reply.ok) return [x(reply.existed === false ? "g.v.none" : "g.v.deleted")];
        return [x("g.v.e." + (reply.error ?? "failed")), x("g.v.notDeleted")];
      }
      if (reply.ok) {
        return [
          x("g.v.saved"),
          x("g.v.savedInfo", { seconds: Math.round(reply.seconds ?? 0), quality: Math.round((reply.quality ?? 0) * 100) }),
          "",
          x("g.v.privacy1"),
          x("g.v.privacy2"),
        ];
      }
      return [x("g.v.e." + (reply.error ?? "failed")), x("g.v.notSaved"), x("g.v.again")];
    }
  }
}

/** While connecting or reading, a tap cancels (nothing is stored); afterwards it just closes. */
export function voiceSheetCancels(sheet: VoiceSheet | null): boolean {
  return sheet !== null && (sheet.kind === "connecting" || sheet.kind === "reading");
}
