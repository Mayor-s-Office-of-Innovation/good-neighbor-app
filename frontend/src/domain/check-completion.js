/*
  Completion rule for a perimeter check (docs/plan-remove-places.md).

  A check is complete when it has at least MIN_PERIMETER_PHOTOS photos OR one
  saved text description. Text is a full alternative to photos, not a
  supplement: staff who cannot take photos write one description of the whole
  perimeter and finish. Mixed evidence counts — two photos plus a description is
  complete, and the photos stay attached.

  Enforcement is client-side only (Finish stays disabled until the rule is met);
  the backend records counts at completion but never refuses.

  Pure functions over the session check shape (state/check-session.js): items
  live under `check.places[placeId].items` (one synthetic place in Phase 1).
*/

export const MIN_PERIMETER_PHOTOS = 5;

/** Minimum trimmed length for a perimeter description to count as evidence. */
export const MIN_DESCRIPTION_LENGTH = 20;

/**
 * @typedef {{ id: string, kind?: string, text?: string, placeId?: string }} EvidenceItem
 * @typedef {{ placeOrder?: string[], places?: Record<string, { items?: EvidenceItem[] }> } | null | undefined} SessionCheck
 */

/**
 * Every evidence item in the check, in capture order.
 * @param {SessionCheck} check
 * @returns {EvidenceItem[]}
 */
export function checkItems(check) {
  if (!check?.places || typeof check.places !== "object") return [];
  const order =
    Array.isArray(check.placeOrder) && check.placeOrder.length
      ? check.placeOrder
      : Object.keys(check.places);
  return order.flatMap((placeId) => {
    const items = check.places?.[placeId]?.items;
    return Array.isArray(items) ? items : [];
  });
}

/**
 * @param {SessionCheck} check
 * @returns {EvidenceItem[]}
 */
export function photoItems(check) {
  return checkItems(check).filter((item) => item?.kind === "photo");
}

/**
 * @param {SessionCheck} check
 * @returns {EvidenceItem[]}
 */
export function textItems(check) {
  return checkItems(check).filter((item) => item?.kind === "text");
}

/**
 * @param {SessionCheck} check
 * @returns {number}
 */
export function photoCount(check) {
  return photoItems(check).length;
}

/**
 * @param {SessionCheck} check
 * @returns {number}
 */
export function textCount(check) {
  return textItems(check).length;
}

/**
 * Any evidence at all (used by cancel/discard decisions, not completion).
 * @param {SessionCheck} check
 * @returns {boolean}
 */
export function hasEvidence(check) {
  return photoCount(check) > 0 || textCount(check) > 0;
}

/**
 * The completion rule: enough photos, or one description.
 * @param {SessionCheck} check
 * @returns {boolean}
 */
export function isPerimeterCheckComplete(check) {
  return photoCount(check) >= MIN_PERIMETER_PHOTOS || textCount(check) >= 1;
}

/**
 * What the capture screen renders: counts plus the rule outcome.
 * @param {SessionCheck} check
 * @returns {{ photos: number, texts: number, complete: boolean, remaining: number }}
 */
export function completionStatus(check) {
  const photos = photoCount(check);
  const texts = textCount(check);
  return {
    photos,
    texts,
    complete: isPerimeterCheckComplete(check),
    remaining: Math.max(0, MIN_PERIMETER_PHOTOS - photos),
  };
}

/**
 * Whether typed text is long enough to save as a perimeter description.
 * @param {string | null | undefined} text
 * @returns {boolean}
 */
export function canSubmitDescription(text) {
  return String(text || "").trim().length >= MIN_DESCRIPTION_LENGTH;
}
