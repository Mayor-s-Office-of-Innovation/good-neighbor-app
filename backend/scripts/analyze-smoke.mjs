// Live smoke test against the deployed analysis service. NOT part of CI or the
// offline harness — it makes real network calls and needs a real GNP consumer
// key, so it is run by hand against `backend/.env` (gitignored):
//
//   ANALYZER_BASE_URL=https://<host>/  ANALYZER_API_KEY=<gnp-key>
//   npm run analyze:smoke -w backend
//
// It (1) fetches the exact rubric version (no key — confirms our pinned
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

  const rubricPath = `/v1/rubrics/${encodeURIComponent(RUBRIC_ID)}/versions/${encodeURIComponent(RUBRIC_VERSION)}`;
  console.log(`\n[1/2] GET ${rubricPath} (unauthenticated)…`);
  const rubricResponse = await fetch(
    `${baseUrl.replace(/\/$/, "")}${rubricPath}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!rubricResponse.ok)
    throw new Error(
      `Pinned rubric endpoint returned HTTP ${rubricResponse.status}`,
    );
  const rubric = await rubricResponse.json();
  if (rubric.id !== RUBRIC_ID || rubric.version !== RUBRIC_VERSION) {
    throw new Error(
      "Published rubric does not match the requested ID and version",
    );
  }
  console.log(
    `  ✓ pinned rubric is published (${rubric.id}@${rubric.version})`,
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

  if (
    response.rubric.id !== RUBRIC_ID ||
    response.rubric.version !== RUBRIC_VERSION
  ) {
    throw new Error(
      "Analysis response does not match the pinned rubric ID and version",
    );
  }
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
