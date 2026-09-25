/** Return the first non-empty address line without city/state suffixes. */
export function firstLocationLine(value) {
  return String(value || "")
    .split(/\r?\n|,/)[0]
    .trim();
}

/**
 * Detail location priority: photo address, site address, then site name.
 * @param {Record<string, any>} task
 * @param {Record<string, any>} site
 * @param {Record<string, any>} request
 * @returns {string}
 */
export function ticketDetailLocation(task, site, request) {
  const photoAddress =
    task?.evidence?.georeferencedAddress || task?.georeferencedAddress;
  const siteAddress = task?.siteAddress || task?.address || site?.address;
  const siteName = task?.evidence?.placeName || request?.location || site?.name;
  return firstLocationLine(photoAddress || siteAddress || siteName);
}
