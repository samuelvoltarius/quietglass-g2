import { mergeRoutes, parseRoutes, parseTombstones, type RouteTombstone, type SavedRoute } from "./saved";

/**
 * Keeps the saved routes the same on the phone and on your own route store
 * (private build: `VITE_ROUTES_URL`), where a planning page on the PC reads
 * and writes them too. One request does both directions: this device sends
 * its routes and deletions, the store merges them with its own and answers
 * with the result, which is merged here once more (changes made while the
 * request was out survive).
 *
 * The request is a plain POST with a text body and no headers of its own, so
 * the browser sends it without a CORS preflight. Sign-in is the tailnet's
 * (`tailscale serve`), nothing is stored in the app.
 */

const BUILD_ROUTES_URL: string | undefined = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_ROUTES_URL;

/** Route store of a private build, without a trailing slash; empty in the public build. */
export function buildRoutesUrl(): string {
  return (BUILD_ROUTES_URL ?? "").trim().replace(/\/+$/, "");
}

export interface RouteSet {
  readonly routes: readonly SavedRoute[];
  readonly deleted: readonly RouteTombstone[];
}

export type RouteSyncError = "offline" | "timeout" | "auth" | "server";

export interface RouteSyncOutcome {
  /** The merged routes, or null when the store could not be reached. */
  readonly result: { routes: SavedRoute[]; deleted: RouteTombstone[] } | null;
  readonly error: RouteSyncError | null;
}

export interface RouteSyncConfig {
  readonly url?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface RouteSync {
  readonly url: string;
  sync(local: RouteSet): Promise<RouteSyncOutcome>;
}

export function createRouteSync(config: RouteSyncConfig = {}): RouteSync | null {
  const url = (config.url ?? buildRoutesUrl()).replace(/\/+$/, "");
  if (!url) return null;
  const doFetch = config.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = config.timeoutMs ?? 8_000;
  return {
    url,
    async sync(local) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(`${url}/routes`, {
          method: "POST",
          body: JSON.stringify({ routes: local.routes, deleted: local.deleted }),
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) return { result: null, error: "auth" };
        if (!response.ok) return { result: null, error: "server" };
        const value = (await response.json()) as { routes?: unknown; deleted?: unknown } | null;
        const remote = { routes: parseRoutes(value?.routes), deleted: parseTombstones(value?.deleted) };
        return { result: mergeRoutes(local, remote), error: null };
      } catch (error) {
        if (controller.signal.aborted) return { result: null, error: "timeout" };
        return { result: null, error: error instanceof TypeError ? "offline" : "server" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** True when two route sets hold the same routes and deletions (order included). */
export function sameRoutes(a: RouteSet, b: RouteSet): boolean {
  return JSON.stringify([a.routes, a.deleted]) === JSON.stringify([b.routes, b.deleted]);
}
