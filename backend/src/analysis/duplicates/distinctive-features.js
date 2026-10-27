// Reject known generic category/scene-only support. This is an evidence-quality
// guard, not a claim that remaining words prove physical identity. Unknown terms
// abstain from lexical rejection; visual/text grounding rules still apply.
const generic = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "on",
  "at",
  "in",
  "near",
  "by",
  "beside",
  "around",
  "with",
  "to",
  "from",
  "is",
  "are",
  "has",
  "have",
  "some",
  "there",
  "same",
  "similar",
  "identical",
  "matching",
  "both",
  "visible",
  "show",
  "shows",
  "image",
  "images",
  "photo",
  "photos",
  "issue",
  "issues",
  "object",
  "objects",
  "item",
  "items",
  "distinctive",
  "specific",
  "features",
  "markings",
  "arrangement",
  "position",
  "location",
  "area",
  "surface",
  "street",
  "streets",
  "sidewalk",
  "sidewalks",
  "pavement",
  "building",
  "buildings",
  "ground",
  "litter",
  "trash",
  "rubbish",
  "debris",
  "waste",
  "garbage",
  "scattered",
  "discarded",
  "paper",
  "plastic",
  "packaging",
  "damage",
  "graffiti",
]);

/**
 * @param {string[]} features
 * @returns {boolean}
 */
export function hasDistinctiveFeatures(features) {
  return features.some((feature) => {
    // A code occupying the whole entry is a marking, not a generic count/date.
    // Pure numbers need an explicit marking label; bare quantities stay rejected.
    const value = feature.trim();
    if (
      /^(?=[\p{L}\p{N}-]*\p{L})(?=[\p{L}\p{N}-]*\p{N})[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(
        value,
      )
    )
      return true;
    if (/^(?:marking|code|serial|identifier)\s*[:#]\s*[0-9]{3,}$/iu.test(value))
      return true;
    return (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).some(
      (word) => /\p{L}/u.test(word) && !generic.has(word),
    );
  });
}
