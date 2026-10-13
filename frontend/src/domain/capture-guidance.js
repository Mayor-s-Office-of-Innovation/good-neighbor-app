import { livePhotoItems } from "./check-completion.js";
/**
 * Counts are today, then the preceding four Pacific completion days, scoped
 * server-side to this Site and capture start instant.
 * @param {number[]} counts
 * @returns {{titleKey: string}}
 */
export function startingGuidance(counts) {
  const [todayCount = 0, ...priorDays] = counts;
  if (
    todayCount === 0 &&
    priorDays.slice(0, 3).length === 3 &&
    priorDays.slice(0, 3).every((count) => count >= 3) &&
    (priorDays[3] || 0) < 3
  ) {
    return { titleKey: "check.title.fourDays" };
  }
  return { titleKey: todayCount === 2 ? "check.title.third" : "check.title" };
}

/**
 * Recompute from retained live photos in capture order, including after deletion.
 * Only classified photos influence framing; pending/unknown photos count toward
 * the total. A requested complementary shot earns the acknowledgement.
 * @param {import("./check-completion.js").SessionCheck} check
 * @param {string} [startingTitleKey]
 * @returns {{ titleKey: string, photos: number, detail: number, wide: number }}
 */
export function captureGuidance(check, startingTitleKey = "check.title") {
  const photos = livePhotoItems(check).filter(
    (photo) => photo.upload?.status !== "failed",
  );
  let detail = 0;
  let wide = 0;
  let requested = "";
  let fulfilled = false;
  for (const photo of photos) {
    const shotType = photo.analysis?.sourceAnalysis?.shotType;
    if (
      (requested === "wide" && shotType === "wide") ||
      (requested === "detail" && shotType === "detail")
    )
      fulfilled = true;
    if (shotType === "detail") detail += 1;
    if (shotType === "wide") wide += 1;
    if (detail >= 2 && wide === 0) requested = "wide";
    if (wide >= 2 && detail === 0) requested = "detail";
  }
  const titleKey =
    photos.length >= 4
      ? "check.title.extra"
      : fulfilled
        ? "check.title.greatShot"
        : detail >= 2 && wide === 0
          ? "check.title.needWide"
          : wide >= 2 && detail === 0
            ? "check.title.needDetail"
            : startingTitleKey;
  return { titleKey, photos: photos.length, detail, wide };
}
