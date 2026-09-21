/*
  Completion rule for a perimeter check (docs/plan-remove-places.md).

  A check is complete when it has at least MIN_PERIMETER_PHOTOS photos OR one
  saved text description. Text is a full alternative to photos, not a
  supplement: staff who cannot take photos write one description of the whole
  perimeter and finish. Mixed evidence counts — two photos plus a description is
  complete, and the photos stay attached.

  Only LIVE evidence counts (itemCountsTowardCompletion): a photo whose upload
  permanently failed with nothing registered can never become a backend
  artifact, so it must not satisfy the rule — the backend would otherwise wait
  forever for an artifact that doesn't exist and the check could never file.

  Enforcement is client-side only (Finish stays disabled until the rule is met);
  the backend records counts at completion but never refuses.

  Pure functions over the session check shape (state/check-session.js): items
  live in `check.items[]` in capture order.
*/

export const MIN_PERIMETER_PHOTOS = 5;

/** Minimum trimmed length for a perimeter description to count as evidence. */
export const MIN_DESCRIPTION_LENGTH = 20;

/**
 * Minimum trimmed length for any registered text artifact: the Street
 * Conditions analysis service rejects text media under 5 characters as a
 * permanent invalid request, so the client never submits shorter notes.
 */
export const MIN_TEXT_EVIDENCE_LENGTH = 5;

/**
 * @typedef {{ id: string, kind?: string, text?: string,
 *   upload?: { status?: string, artifactId?: string },
 *   analysis?: { status?: string, artifactId?: string } }} EvidenceItem
 * @typedef {{ items?: EvidenceItem[] } | null | undefined} SessionCheck
 */

/**
 * Whether an item can still become a registered backend artifact.
 *
 * Completion counts LIVE evidence only: an artifact must exist (or be
 * plausibly on its way) for the backend to include it in the scorecard. An
 * item that permanently failed its upload with nothing registered (no
 * artifactId anywhere) can never produce one — Finish counting it would
 * complete a check whose backend artifact set can never reach the expected
 * count, hanging the background finalization until timeout.
 *
 * A registered item always counts (its analysis may have failed, but the
 * backend artifact exists and the completion gate knows it). An in-flight
 * item (idle/queued/analyzing — the pre-registration states run() passes
 * through) also counts: it hasn't failed yet.
 * @param {EvidenceItem} item
 * @returns {boolean}
 */
export function itemCountsTowardCompletion(item) {
  if (!item) return false;
  if (item.analysis?.artifactId || item.upload?.artifactId) return true;
  if (item.analysis?.status === "failed") return false;
  return true;
}

/**
 * Every evidence item in the check, in capture order.
 * @param {SessionCheck} check
 * @returns {EvidenceItem[]}
 */
export function checkItems(check) {
  return Array.isArray(check?.items) ? check.items.filter(Boolean) : [];
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
 * @returns {EvidenceItem[]}
 */
export function livePhotoItems(check) {
  return photoItems(check).filter(itemCountsTowardCompletion);
}

/**
 * @param {SessionCheck} check
 * @returns {EvidenceItem[]}
 */
export function liveTextItems(check) {
  return textItems(check).filter(itemCountsTowardCompletion);
}

/**
 * @param {SessionCheck} check
 * @returns {number}
 */
export function photoCount(check) {
  return livePhotoItems(check).length;
}

/**
 * @param {SessionCheck} check
 * @returns {number}
 */
export function textCount(check) {
  return liveTextItems(check).length;
}

/**
 * Any evidence at all (used by cancel/discard decisions, not completion).
 * Raw counts — dead items still exist locally and a user must be able to
 * cancel out of a walk whose uploads all failed.
 * @param {SessionCheck} check
 * @returns {boolean}
 */
export function hasEvidence(check) {
  return photoItems(check).length > 0 || textItems(check).length > 0;
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
