import { livePhotoItems } from "./check-completion.js";
import { pacificDaysAgo } from "../i18n/dates.js";

/**
 * Site-wide completed perimeter checks, grouped by completion day. Missing
 * flowType means perimeter for headers created before separate problem reports.
 * @param {Array<{checkId?: string, status?: string, flowType?: string, completedAt?: string}>} headers
 * @param {string} startedAt
 * @param {string} checkId
 * @returns {{ titleKey: string }}
 */
export function startingGuidance(headers, startedAt, checkId) {
  const started = new Date(startedAt);
  const counts = new Map();
  for (const header of headers) {
    if (
      header.checkId === checkId ||
      header.status !== "completed" ||
      header.flowType === "single-problem" ||
      !header.completedAt ||
      new Date(header.completedAt) > started
    )
      continue;
    const daysAgo = pacificDaysAgo(header.completedAt, started);
    if (daysAgo !== null && daysAgo >= 0 && daysAgo <= 4) {
      counts.set(daysAgo, (counts.get(daysAgo) || 0) + 1);
    }
  }
  const todayCount = counts.get(0) || 0;
  const priorDays = [1, 2, 3, 4].map((day) => counts.get(day) || 0);
  if (
    todayCount === 0 &&
    priorDays.slice(0, 3).every((count) => count >= 3) &&
    priorDays[3] < 3
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
