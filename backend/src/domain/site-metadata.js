import {
  GeocodingError,
  geocodeAddress,
} from "../integrations/census-geocoder.js";

/**
 * Geocode a site address while keeping provider failures in the domain error
 * vocabulary used by both admin surfaces.
 * @param {string} address
 * @returns {Promise<{ latitude: number, longitude: number, matchedAddress: string } | GeocodingError>}
 */
export async function geocodeSiteAddress(address) {
  try {
    return await geocodeAddress(address);
  } catch (error) {
    return error instanceof GeocodingError
      ? error
      : new GeocodingError("geocoding_unavailable");
  }
}

/**
 * @param {Record<string, unknown>} site
 * @returns {{ latitude: number, longitude: number, matchedAddress: string } | GeocodingError}
 */
export function locationFromSite(site) {
  const location =
    site.location && typeof site.location === "object"
      ? /** @type {Record<string, unknown>} */ (site.location)
      : {};
  const latitude = location.latitude;
  const longitude = location.longitude;
  if (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  ) {
    return {
      latitude,
      longitude,
      matchedAddress: String(site.geocodedAddress ?? site.address ?? ""),
    };
  }
  return new GeocodingError("address_not_found");
}

/**
 * @param {string} siteId
 * @param {string} name
 * @param {string} providerId
 * @param {string} providerName
 * @param {string} providerSiteId
 * @param {string} now
 * @returns {Record<string, unknown>}
 */
export function siteSearchItem(
  siteId,
  name,
  providerId,
  providerName,
  providerSiteId,
  now,
) {
  return {
    pk: "SITE_SEARCH#ACTIVE",
    sk: siteSearchSk(name, siteId),
    type: "siteSearch",
    siteId,
    siteName: name,
    providerId,
    providerName,
    providerSiteId,
    label: `${name} (${providerName})`,
    searchText: `${name} ${providerName}`.toLowerCase(),
    status: "active",
    updatedAt: now,
  };
}

/**
 * @param {string} name
 * @param {string} siteId
 * @returns {string}
 */
export function siteSearchSk(name, siteId) {
  return `${name.toLowerCase()}#${siteId}`;
}
