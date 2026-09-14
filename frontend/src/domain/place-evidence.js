/**
 * @param {{ items?: Array<{ kind?: string }>, description?: { validated?: boolean } } | null | undefined} place
 * @returns {boolean}
 */
export function hasPlaceEvidence(place) {
  return Boolean(
    (Array.isArray(place?.items) &&
      place.items.some(
        (item) => item.kind === "photo" || item.kind === "text",
      )) ||
      place?.description?.validated,
  );
}
