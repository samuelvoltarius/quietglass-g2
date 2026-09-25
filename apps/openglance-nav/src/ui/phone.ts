import {
  addPlace, destinationOf, nextPlaceId, parseCoordinates, removePlace,
  usesMockRouter, validateRouterUrl, type NavData,
} from "../storage/persist";
import type { LatLng } from "../geo/geometry";
import type { TravelMode } from "../routing/provider";

/**
 * The phone companion: router, destination and mode.
 *
 * Destination entry is coordinates or saved places rather than a search box,
 * because geocoding would mean a third service — and the point of this app is
 * that you can run every piece of it yourself.
 */

export interface PhoneUiPorts {
  readonly getData: () => NavData;
  readonly setData: (data: NavData) => Promise<void>;
  readonly getPosition: () => LatLng | null;
}

const MODE_LABELS: Readonly<Record<TravelMode, string>> = {
  walking: "Walking",
  cycling: "Cycling",
  driving: "Driving — minimal display",
};

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  let notice = "";
  const render = (): void => {
    const data = ports.getData();
    root.innerHTML = template(data, notice, ports.getPosition());
    notice = "";
    wire(root, ports, data, (message) => { notice = message; render(); });
  };
  render();
}

function template(data: NavData, notice: string, position: LatLng | null): string {
  const destination = destinationOf(data);

  return `
  <header class="brand">
    <span class="brand-mark">Quietglass</span>
    <h1>OpenGlance</h1>
  </header>

  ${notice ? '<p class="notice">' + escapeHtml(notice) + "</p>" : ""}

  ${usesMockRouter(data) ? `
  <section class="card">
    <h2>Using the mock router</h2>
    <p class="hint">
      No Valhalla server is configured, so a fixed demonstration route is used
      and the glasses show <strong>MOCK</strong>. It exercises the whole
      navigation pipeline without a server — it does not route anywhere real.
    </p>
  </section>` : ""}

  <section class="card">
    <h2>Routing server</h2>
    <label for="url">Valhalla URL</label>
    <input id="url" type="text" value="${escapeHtml(data.valhallaUrl)}" placeholder="https://valhalla.example" />
    <p class="hint">
      Leave empty for the mock. OpenGlance posts to <code>/route</code> with
      OpenStreetMap costing — no API key, no quota, no account. Host it yourself
      or use a public instance you trust.
    </p>
    <button id="save-url" type="button">Save</button>
  </section>

  <section class="card">
    <h2>Mode</h2>
    <select id="mode">
      ${(Object.keys(MODE_LABELS) as TravelMode[]).map((mode) =>
        '<option value="' + mode + '"' + (mode === data.mode ? " selected" : "") + ">" +
        escapeHtml(MODE_LABELS[mode]) + "</option>").join("")}
    </select>
    <p class="hint">
      In driving mode the glasses show only the arrow, the distance and the road
      name — no arrival time, nothing else. A navigation display in a car
      competes with the road.
    </p>
  </section>

  <section class="card">
    <h2>Destination</h2>
    <p class="hint">
      ${destination
        ? "Selected: <strong>" + escapeHtml(destination.label) + "</strong>"
        : "No destination selected."}
    </p>
    <ul class="scripts">
      ${data.places.map((place) => `
        <li>
          <label>
            <input type="radio" name="dest" value="${escapeHtml(place.id)}"
              ${place.id === data.destinationId ? "checked" : ""} />
            <span>${escapeHtml(place.label)}<br />
              <small>${place.at.lat.toFixed(5)}, ${place.at.lon.toFixed(5)}</small></span>
          </label>
          <button type="button" class="remove" data-id="${escapeHtml(place.id)}">Remove</button>
        </li>`).join("")}
    </ul>

    <label for="label">Add a place — name</label>
    <input id="label" type="text" placeholder="Home, site, trailhead" />
    <label for="coords">Coordinates (lat, lon)</label>
    <input id="coords" type="text" placeholder="52.52000, 13.40500" />
    <button id="add" type="button">Add place</button>
    ${position ? '<button id="here" type="button" class="secondary">Use current position</button>' : ""}
    <p class="hint">
      Coordinates rather than a search box: geocoding would mean relying on a
      third service, and the point of OpenGlance is that every piece can be
      yours. Copy them from any map.
    </p>
  </section>

  <section class="card">
    <h2>Controls on the glasses</h2>
    <table class="keys">
      <tr><td>Tap</td><td>Start navigating · retry · reroute when off route</td></tr>
      <tr><td>Hold</td><td>Stop navigating</td></tr>
      <tr><td>Double tap</td><td>Leave OpenGlance</td></tr>
    </table>
    <p class="hint">
      Rerouting after a wrong turn happens automatically — it is not something
      a driver should have to ask for.
    </p>
  </section>

  <footer class="hint">
    Your position is used to route and is never stored or transmitted anywhere
    except to the routing server you configure.
  </footer>`;
}

function wire(
  root: HTMLElement,
  ports: PhoneUiPorts,
  data: NavData,
  notify: (message: string) => void,
): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);
  const commit = (next: NavData): void => { void ports.setData(next); };

  byId<HTMLButtonElement>("save-url")?.addEventListener("click", () => {
    const url = byId<HTMLInputElement>("url")?.value.trim() ?? "";
    const check = validateRouterUrl(url);
    if (!check.valid) { notify(check.errors.join(" ")); return; }
    commit({ ...data, valhallaUrl: url });
  });

  byId<HTMLSelectElement>("mode")?.addEventListener("change", (event) => {
    commit({ ...data, mode: (event.target as HTMLSelectElement).value as TravelMode });
  });

  root.querySelectorAll<HTMLInputElement>('input[name="dest"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) commit({ ...data, destinationId: radio.value });
    });
  });

  root.querySelectorAll<HTMLButtonElement>(".remove").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset["id"];
      if (id) commit(removePlace(data, id));
    });
  });

  const addWith = (at: LatLng): void => {
    const label = byId<HTMLInputElement>("label")?.value.trim() ?? "";
    if (!label) { notify("Give the place a name."); return; }
    commit(addPlace(data, { id: nextPlaceId(data), label, at }));
  };

  byId<HTMLButtonElement>("add")?.addEventListener("click", () => {
    const text = byId<HTMLInputElement>("coords")?.value ?? "";
    const at = parseCoordinates(text);
    if (!at) { notify("Coordinates must look like 52.52000, 13.40500."); return; }
    addWith(at);
  });

  byId<HTMLButtonElement>("here")?.addEventListener("click", () => {
    const at = ports.getPosition();
    if (!at) { notify("No position available yet."); return; }
    addWith(at);
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
