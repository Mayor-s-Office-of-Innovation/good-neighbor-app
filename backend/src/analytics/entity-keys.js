// Reporting entities are an allowlist of complete key shapes. Keep these patterns
// compatible with both JavaScript RegExp and DuckDB regexp_full_match so ingestion
// and reads of older Parquet agree. Unknown children are operational records,
// not additional headers. IDs are opaque: do not require UUIDs for legacy data.

/** @type {Record<string, { pk: string, sk: string }>} */
export const ENTITY_KEY_SHAPES = {
  checks: { pk: "SITE#[^#]+", sk: "CHECK#[^#]+" },
  tasks: { pk: "SITE#[^#]+", sk: "TASK#[^#]+" },
  conditions: { pk: "SITE#[^#]+", sk: "ASSESSMENT#[^#]+#COND#[^#]+" },
  assessments: { pk: "SITE#[^#]+", sk: "ASSESSMENT#[^#]+" },
  // Pre-photo-roll artifacts include a place ID before their artifact ID.
  artifacts: { pk: "SITE#[^#]+", sk: "CHECK#[^#]+#ART#[^#]+(#[^#]+)?" },
  analyses: { pk: "SITE#[^#]+", sk: "CHECK#[^#]+#ANALYSIS#[^#]+" },
  sites: { pk: "SITE#[^#]+", sk: "#META" },
  providers: { pk: "PROVIDER#[^#]+", sk: "#META" },
  devices: { pk: "SITE#[^#]+", sk: "DEVICE#[^#]+" },
};

const matchers = Object.entries(ENTITY_KEY_SHAPES).map(([entity, shape]) => ({
  entity,
  pk: new RegExp(`^(?:${shape.pk})$`),
  sk: new RegExp(`^(?:${shape.sk})$`),
}));

/**
 * Classify a complete primary key; operational children and malformed keys skip.
 * @param {{ pk?: unknown, sk?: unknown }} key
 * @returns {string | null}
 */
export function classifyItem({ pk, sk }) {
  if (typeof pk !== "string" || typeof sk !== "string") return null;
  return (
    matchers.find((shape) => shape.pk.test(pk) && shape.sk.test(sk))?.entity ??
    null
  );
}
