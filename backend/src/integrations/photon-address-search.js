/* global AbortSignal */

// Photon provides low-volume, search-as-you-type suggestions from OpenStreetMap.
// Keep it behind our API so the browser does not disclose admin activity to a
// third party directly and so the provider can be changed without a UI release.
const ENDPOINT = "https://photon.komoot.io/api/";
const TIMEOUT_MS = 5_000;
const MAX_RESULTS = 5;
const SAN_FRANCISCO_BBOX = "-122.5149,37.7081,-122.3569,37.8324";

export class AddressSearchError extends Error {
  constructor() {
    super("address_search_unavailable");
  }
}

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   addressParts: {
 *     streetNumber: string,
 *     streetAddress: string,
 *     secondLine: string,
 *     city: string,
 *     state: string,
 *     zip: string,
 *   }
 * }} AddressSuggestion
 */

/**
 * Find likely San Francisco street addresses.
 * @param {string} input
 * @returns {Promise<AddressSuggestion[]>}
 */
export async function searchAddresses(input) {
  const query = String(input || "")
    .trim()
    .slice(0, 160);
  if (query.length < 3) return [];

  const url = new URL(ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(MAX_RESULTS));
  url.searchParams.set("lang", "en");
  url.searchParams.set("bbox", SAN_FRANCISCO_BBOX);
  url.searchParams.set("layer", "house");

  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "good-neighbor-address-search/1.0" },
    });
  } catch {
    throw new AddressSearchError();
  }
  if (!response.ok) throw new AddressSearchError();

  let body;
  try {
    body = await response.json();
  } catch {
    throw new AddressSearchError();
  }

  const suggestions = [];
  const seenLabels = new Set();
  for (const feature of Array.isArray(body?.features) ? body.features : []) {
    const properties = feature?.properties || {};
    const streetNumber = clean(properties.housenumber);
    const streetAddress = clean(properties.street || properties.name);
    const city = clean(
      properties.city || properties.locality || properties.county,
    );
    const state = stateCode(properties.state, properties.statecode);
    const zip = clean(properties.postcode).slice(0, 10);
    if (!streetNumber || !streetAddress || !city || !state || !zip) continue;
    const label = `${streetNumber} ${streetAddress}, ${city}, ${state} ${zip}`;
    if (seenLabels.has(label.toLowerCase())) continue;
    seenLabels.add(label.toLowerCase());
    suggestions.push({
      id: clean(properties.osm_id) || label,
      label,
      addressParts: {
        streetNumber,
        streetAddress,
        secondLine: "",
        city,
        state,
        zip,
      },
    });
  }
  return suggestions;
}

/** @param {unknown} value */
function clean(value) {
  return String(value ?? "").trim();
}

/** @param {unknown} state @param {unknown} stateCodeValue */
function stateCode(state, stateCodeValue) {
  const explicit = clean(stateCodeValue).toUpperCase();
  if (/^[A-Z]{2}$/.test(explicit)) return explicit;
  const normalized = clean(state).toLowerCase();
  if (normalized === "california") return "CA";
  const short = clean(state).toUpperCase();
  return /^[A-Z]{2}$/.test(short) ? short : "";
}
