// Live smoke test against the deployed analysis service. NOT part of CI or the
// offline harness — it makes real network calls and needs a real GNP consumer
// key, so it is run by hand against `backend/.env` (gitignored):
//
//   ANALYZER_BASE_URL=https://<host>/  ANALYZER_API_KEY=<gnp-key>
//   npm run analyze:smoke -w backend
//
// It (1) lists rubrics (no key — proves connectivity + confirms our pinned
// rubric is published) and (2) sends one text-only analysis through the real
// client, then prints the adapted scorecard. The API key is read from the
// environment and never logged.

import {
  createAnalyzerClient,
  AnalyzerError,
} from "../src/analysis/analyzer-client.js";
import { adaptAssessment } from "../src/analysis/adapt-scorecard.js";
import { RUBRIC_ID, RUBRIC_VERSION } from "../src/analysis/contract.js";

const baseUrl = process.env.ANALYZER_BASE_URL;
const apiKey = process.env.ANALYZER_API_KEY;

if (!baseUrl || !apiKey) {
  console.error(
    "Missing ANALYZER_BASE_URL and/or ANALYZER_API_KEY.\n" +
      "Add them to backend/.env (gitignored) and run: npm run analyze:smoke -w backend",
  );
  process.exit(1);
}

const client = createAnalyzerClient({ baseUrl, apiKey });

async function main() {
  console.log(
    `→ ${baseUrl}  (targeting rubric ${RUBRIC_ID}@${RUBRIC_VERSION})`,
  );

  console.log("\n[1/2] GET /v1/rubrics (unauthenticated)…");
  const rubrics = await client.listRubrics();
  const published = Array.isArray(rubrics?.rubrics) ? rubrics.rubrics : [];
  const match = published.find((r) => r.id === RUBRIC_ID);
  console.log(
    `  published rubrics: ${published.map((r) => `${r.id}@${r.version}`).join(", ") || "(none)"}`,
  );
  console.log(
    match
      ? `  ✓ our pinned rubric is published (${match.id}@${match.version})`
      : `  ⚠ pinned rubric ${RUBRIC_ID}@${RUBRIC_VERSION} not found in listing`,
  );

  console.log("\n[2/2] POST /v1/analyses (x-api-key, text-only)…");
  const response = await client.analyze({
    metadata: {
      reported_at: new Date().toISOString(),
      latitude: 37.7749,
      longitude: -122.4194,
      position_descriptor: "smoke-test: north gate",
    },
    media: [
      {
        type: "text",
        text: "Smoke test: the north gate perimeter is clear, no litter or hazards observed.",
      },
    ],
    requestId: `smoke-${process.pid}`,
    appId: "good-neighbor-app",
  });

  const adapted = adaptAssessment(response);
  console.log(`  ✓ analysis_id: ${adapted.analysisId}`);
  console.log(`  ✓ grade: ${adapted.grade} — ${adapted.gradeDescription}`);
  console.log(
    `  ✓ concerns: ${adapted.issueCount} (maxSeverity ${adapted.maxSeverity})`,
  );
  console.log("\n✅ live analyzer smoke passed.");
}

main().catch((error) => {
  if (error instanceof AnalyzerError) {
    console.error(
      `\n❌ AnalyzerError${error.status ? ` (${error.status})` : ""}: ${error.message}` +
        (error.code ? `\n   code: ${error.code}` : "") +
        (error.details?.length
          ? `\n   details: ${error.details.join("; ")}`
          : "") +
        `\n   retryable: ${error.retryable}`,
    );
  } else {
    console.error("\n❌ smoke failed:", error);
  }
  process.exit(1);
});
