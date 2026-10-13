import type { Locale } from "../i18n";
import { t } from "../messages";
import type { GeoResult } from "../route/geocode";
import { MAX_FAVORITES, MAX_NAME, type Places } from "../route/places";

/**
 * HTML for the destination lists on the phone page. Plain strings, so they can
 * be checked without a browser; every piece of text that came from outside
 * (a place name from the search, a name typed by the user) is escaped.
 */

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function resultsHtml(results: readonly GeoResult[], locale: Locale): string {
  return results.map((result, index) => `
    <li>
      <div class="place-text"><strong>${escapeHtml(result.name)}</strong><span class="hint">${escapeHtml(result.detail)}</span></div>
      <div class="place-actions">
        <button type="button" class="small" data-act="save" data-i="${index}">${t(locale, "p.saveFavorite")}</button>
        <button type="button" class="small ghost" data-act="now" data-i="${index}">${t(locale, "p.goNow")}</button>
      </div>
    </li>`).join("");
}

export function favoritesHtml(places: Places, locale: Locale): string {
  if (places.favorites.length === 0) return `<li class="hint">${t(locale, "p.noFavorites")}</li>`;
  return places.favorites.map((place, index) => `
    <li>
      <input type="text" class="fav-name" data-id="${escapeHtml(place.id)}" maxlength="${MAX_NAME}"
             value="${escapeHtml(place.name)}" aria-label="${t(locale, "p.rename")}" />
      <div class="place-actions">
        <button type="button" class="small ghost" data-act="up" data-id="${escapeHtml(place.id)}"
                aria-label="${t(locale, "p.up")}"${index === 0 ? " disabled" : ""}>↑</button>
        <button type="button" class="small ghost" data-act="down" data-id="${escapeHtml(place.id)}"
                aria-label="${t(locale, "p.down")}"${index === places.favorites.length - 1 ? " disabled" : ""}>↓</button>
        <button type="button" class="small ghost" data-act="remove" data-id="${escapeHtml(place.id)}">${t(locale, "p.remove")}</button>
      </div>
    </li>`).join("");
}

export function nowHtml(places: Places, locale: Locale): string {
  if (!places.now) return `<span class="hint">${t(locale, "p.nowNone")}</span>`;
  return `<strong>${escapeHtml(places.now.name)}</strong>
    <button type="button" class="small ghost" data-act="clear-now">${t(locale, "p.nowClear")}</button>
    <span class="hint">${t(locale, "p.nowSet")}</span>`;
}

/** Shown when the list is full, so a click on "save" is never silently ignored. */
export function fullText(locale: Locale): string {
  return t(locale, "p.favoritesFull", { max: MAX_FAVORITES });
}
