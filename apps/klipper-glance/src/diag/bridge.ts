import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { diag, diagOn, flushDiag } from "./diag";

/** Calls on the glasses worth timing: page building, text/image updates and the exit dialog. */
const TRACED = new Set([
  "createStartUpPageContainer", "rebuildPageContainer", "textContainerUpgrade",
  "updateImageRawData", "shutDownPageContainer",
]);

function short(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  try { return JSON.stringify(value).slice(0, 120); } catch { return String(value).slice(0, 120); }
}

/**
 * Private step log only: wraps the bridge so every traced call is recorded with
 * its time, how long it took and what it returned, and every event from the
 * glasses with its raw shape. Without a traffic URL the bridge comes back untouched.
 */
export function traceBridge(bridge: EvenAppBridge): EvenAppBridge {
  if (!diagOn()) return bridge;
  return new Proxy(bridge, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      const name = String(prop);
      if (name === "onEvenHubEvent") {
        return (cb: (event: unknown) => void) => value.call(target, (event: unknown) => {
          diag("event", { raw: short(event) as string });
          cb(event);
        });
      }
      if (!TRACED.has(name)) return value.bind(target);
      return (...args: unknown[]) => {
        const started = Date.now();
        diag("call", { fn: name, arg: name === "shutDownPageContainer" ? short(args[0]) : null });
        const out = value.apply(target, args);
        if (out && typeof (out as Promise<unknown>).then === "function") {
          (out as Promise<unknown>).then(
            (result) => {
              diag("done", { fn: name, ms: Date.now() - started, result: short(result) });
              if (name === "shutDownPageContainer") void flushDiag();
            },
            (error: unknown) => diag("fail", { fn: name, ms: Date.now() - started, error: String(error).slice(0, 120) }),
          );
        }
        return out;
      };
    },
  });
}
