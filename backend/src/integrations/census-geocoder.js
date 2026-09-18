/* global AbortSignal */
/*
  Census Geocoder boundary. Site addresses are geocoded server-side so clients
  cannot choose the coordinates used for 311 filings. The public Census API is
  US-only, which matches the service area for this application.
*/

const ENDPOINT =
  "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const TIMEOUT_MS = 8_000;

export class GeocodingError extends Error {
  /** @param {"address_not_found" | "geocoding_unavailable"} code */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * @param {string} address
 * @returns {Promise<{ latitude: number, longitude: number, matchedAddress: string }>}
 */
export async function geocodeAddress(address) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("address", address);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new GeocodingError("geocoding_unavailable");
  }
  if (!response.ok) throw new GeocodingError("geocoding_unavailable");

  let body;
  try {
    body = await response.json();
  } catch {
    throw new GeocodingError("geocoding_unavailable");
  }
  const match = body?.result?.addressMatches?.[0];
  const latitude = match?.coordinates?.y;
  const longitude = match?.coordinates?.x;
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new GeocodingError("address_not_found");
  }
  return {
    latitude,
    longitude,
    matchedAddress: String(match.matchedAddress ?? address),
  };
}
