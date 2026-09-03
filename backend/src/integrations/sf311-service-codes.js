import { DEFAULT_CLASSIFIER_SERVICE_CODE_MAP } from "./sf311-classifier-service-code-map.js";

const SERVICE_CODE_PATTERN = /^\d+(?:\.\d+)+$/;

const ANALYSIS_COMMANDS = new Map([
  ["run bulky item analysis", "bulky-items"],
  ["run graffiti analysis", "graffiti"],
]);

/**
 * @param {string | null | undefined} raw
 * @returns {{ kind: "none" } | { kind: "service_code", serviceCode: string } | { kind: "classifier", classifierId: string }}
 */
export function parseServiceCodeOrAction(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { kind: "none" };
  if (SERVICE_CODE_PATTERN.test(value)) {
    return { kind: "service_code", serviceCode: value };
  }
  const classifierId = ANALYSIS_COMMANDS.get(value.toLowerCase());
  if (classifierId) return { kind: "classifier", classifierId };
  return { kind: "none" };
}

/**
 * @param {string | undefined} raw
 * @returns {Record<string, Record<string, string>>}
 */
export function parseClassifierServiceCodeMap(raw) {
  if (!raw) return DEFAULT_CLASSIFIER_SERVICE_CODE_MAP;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SF311_CLASSIFIER_SERVICE_CODE_MAP must be a JSON object");
  }
  return mergeClassifierServiceCodeMap(
    DEFAULT_CLASSIFIER_SERVICE_CODE_MAP,
    /** @type {Record<string, Record<string, string>>} */ (parsed),
  );
}

/**
 * @param {Record<string, Record<string, string>>} base
 * @param {Record<string, Record<string, string>>} override
 * @returns {Record<string, Record<string, string>>}
 */
function mergeClassifierServiceCodeMap(base, override) {
  const merged = Object.fromEntries(
    Object.entries(base).map(([classifierId, classifierMap]) => [
      classifierId,
      { ...classifierMap },
    ]),
  );
  for (const [classifierId, classifierMap] of Object.entries(override)) {
    if (
      !classifierMap ||
      typeof classifierMap !== "object" ||
      Array.isArray(classifierMap)
    ) {
      throw new Error(
        "SF311_CLASSIFIER_SERVICE_CODE_MAP values must be JSON objects",
      );
    }
    merged[classifierId] = {
      ...(merged[classifierId] ?? {}),
      ...classifierMap,
    };
  }
  return merged;
}

/**
 * @param {object} params
 * @param {string} params.classifierId
 * @param {string[]} params.labels
 * @param {Record<string, Record<string, string>>} [params.map]
 * @returns {string[]}
 */
export function serviceCodesForClassifierLabels({
  classifierId,
  labels,
  map = DEFAULT_CLASSIFIER_SERVICE_CODE_MAP,
}) {
  const classifierMap = map[classifierId] ?? {};
  const normalizedLabels = labels.map((label) => label.trim());
  const serviceCodes = labels
    .map((label) => classifierMap[label.trim()])
    .filter(Boolean);
  const missing = normalizedLabels.filter((label) => !classifierMap[label]);
  if (missing.length > 0) {
    throw new Error(
      `No SF311 service-code mapping for ${classifierId}: ${missing.join(", ")}`,
    );
  }
  return [...new Set(serviceCodes)];
}
