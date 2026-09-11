export const SHORT_CODE_LENGTH = 3;

const SHORT_CODE_PATTERN = /^[A-Z0-9]{3}$/;

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeExplicitShortCode(value) {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return SHORT_CODE_PATTERN.test(normalized) ? normalized : "";
}

/**
 * @param {unknown} fallback
 * @returns {string}
 */
export function deriveLegacyShortCode(fallback) {
  return (
    String(fallback ?? "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, SHORT_CODE_LENGTH) || "GNP"
  );
}

/**
 * @param {unknown} value
 * @param {unknown} fallback
 * @returns {string}
 */
export function shortCodePart(value, fallback) {
  return normalizeExplicitShortCode(value) || deriveLegacyShortCode(fallback);
}
