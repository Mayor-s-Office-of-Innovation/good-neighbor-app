// @ts-check
/*
  Control surface for the analyzer stub (helpers/analyzer-stub.mjs). Tests call
  stubAnalyzerFixture(page, "multi" | "excellent") BEFORE uploading a photo so
  the next /v1/analyses call returns the matching canned verdict. Direct
  loopback HTTP (node side), not page context — the worker calls the stub
  server-to-server.
*/
const STUB = "http://127.0.0.1:3101";

/**
 * @param {"multi" | "excellent"} fixture
 * @returns {Promise<void>}
 */
export async function setAnalyzerFixture(fixture) {
  const res = await fetch(`${STUB}/__control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fixture }),
  });
  if (!res.ok) {
    throw new Error(`analyzer-stub control failed: ${res.status}`);
  }
}
