import { DEFAULT_TIMEOUT_MS, haHttpBase, requestJson } from "./errors";
import { parseRelayDevices, type Device } from "../storage/persist";

/**
 * The relay of a private build (VITE_HA_RELAY): `GET <relay>/config` lists the devices
 * (`{"devices":[{"entityId","remoteId","name"}]}`). A plain GET without custom headers, so the WebView
 * needs no CORS preflight. Throws ApiError (unreachable, timeout, auth, ...) like every other request.
 */
export async function fetchRelayDevices(relay: string, options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<Device[]> {
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const raw = await requestJson(doFetch, haHttpBase(relay) + "/config", { method: "GET" }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return parseRelayDevices(raw);
}
