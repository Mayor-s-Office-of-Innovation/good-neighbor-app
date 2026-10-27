import { createSupportHandler } from "../src/support/handler.js";
import { evaluationCases } from "../src/support/evaluation.js";

if (!process.argv.includes("--live")) {
  console.log(
    "No model calls made. Run with --live and SUPPORT_MODEL_ID/AWS_REGION to evaluate synthetic prompts in the dev account. This incurs Bedrock usage.",
  );
  process.exit(0);
}
if (!process.env.SUPPORT_MODEL_ID || !process.env.AWS_REGION)
  throw new Error(
    "Set SUPPORT_MODEL_ID and AWS_REGION explicitly for the dev account.",
  );
const handler = createSupportHandler({
  env: {
    ...process.env,
    SUPPORT_ENABLED: "true",
    SUPPORT_ORIGIN_TOKEN: "local-evaluation",
  },
  log: () => {},
});
let failures = 0;
for (const locale of ["en", "es", "fil", "vi", "zh-Hant"]) {
  for (const item of evaluationCases) {
    const result = await handler({
      headers: { "x-support-origin": "local-evaluation" },
      requestContext: { http: { method: "POST" } },
      body: JSON.stringify({ question: item.question, locale }),
    });
    const body = JSON.parse(result.body);
    const pass =
      result.statusCode === 200 &&
      body.outcome === item.outcome &&
      (!item.sources.length ||
        body.sources.some(({ id }) => item.sources.includes(id)));
    if (!pass) failures++;
    console.log(JSON.stringify({ case: item.id, locale, pass, ...body }));
  }
}
console.log(
  `Contract failures: ${failures}. Human review of grounding and translated answers is still required, even when all contracts pass.`,
);
if (failures) process.exitCode = 1;
