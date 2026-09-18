/*
  Local stub for the Street Conditions analyzer. Serves schema-valid analyze
  responses so e2e tests are deterministic (canned photo → canned verdict)
  with zero cloud dependency — identical locally and in CI, where no
  ANALYZER_API_KEY exists.

  Selection contract: tests set the next fixture via POST /__control
  {fixture:"multi"|"excellent"} BEFORE uploading a photo, then read it back to
  confirm. The stub serves that fixture for every /v1/analyses call until
  changed. Size/byte heuristics don't work here: the worker downscales photos
  (sharp, 1568px q80) before the call, which collapses the size gap between
  test photos. Setting-then-uploading is race-free at workers:1 with one photo
  in flight per step.
*/
import { createServer } from "node:http";

const PORT = Number(process.env.LOCAL_ANALYZER_PORT ?? 3101);

/** Fixture served for /v1/analyses until /__control changes it. */
let pendingFixture = "multi";

const multi = {
  analysis_id: "ana_e2e_multi01",
  rubric: { id: "good-neighbor-app", version: "1.0.0" },
  created_at: new Date().toISOString(),
  model: { provider: "stub", model_id: "e2e-stub" },
  caller: { app_id: "good-neighbor-app" },
  assessment: {
    metadata: {
      reported_at: new Date().toISOString(),
      latitude: 37.76656393517443,
      longitude: -122.4213267021692,
      position_descriptor: "15th St",
    },
    general_conditions: {
      label: "Very Poor",
      description:
        "The perimeter shows urgent concerns posing an immediate risk to health or safety.",
    },
    identified_conditions_of_concern: [
      {
        category: "Temporary shelters",
        definition:
          "Visible evidence of people living or sleeping in public spaces without shelter.",
        severity: 3,
        severity_label: "Moderate: Increasing number, density, or permanence",
        user_friendly_label: "Tent and bedding against wall",
        description: "A tent set up against the wall with bedding.",
        evidence_indices: [0],
        confidence: 0.9,
      },
      {
        category: "Litter",
        definition:
          "Scattered small refuse or litter that does not obstruct movement.",
        severity: 2,
        severity_label: "Minor: Increasing quantity, size, or spatial impact",
        user_friendly_label: "Trash scattered along curb",
        description: "Several wrappers and a plastic bag along the curb.",
        evidence_indices: [0],
        confidence: 0.8,
      },
      {
        category: "Graffiti",
        definition: "Visible tagging or defacement of surfaces.",
        severity: 2,
        severity_label: "Minor: Increasing quantity, size, or spatial impact",
        user_friendly_label: "Tagging on the frontage",
        description: "Tagging visible on the building frontage.",
        evidence_indices: [0],
        confidence: 0.75,
      },
    ],
  },
};

const excellent = {
  analysis_id: "ana_e2e_clean01",
  rubric: { id: "good-neighbor-app", version: "1.0.0" },
  created_at: new Date().toISOString(),
  model: { provider: "stub", model_id: "e2e-stub" },
  caller: { app_id: "good-neighbor-app" },
  assessment: {
    metadata: {
      reported_at: new Date().toISOString(),
      latitude: 37.76656393517443,
      longitude: -122.4213267021692,
      position_descriptor: "Front entrance",
    },
    general_conditions: {
      label: "Excellent",
      description:
        "No concerning street conditions were observed along the perimeter.",
    },
    identified_conditions_of_concern: [],
  },
};

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url?.startsWith("/healthz")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "analyzer-stub" }));
    return;
  }
  if (req.method === "POST" && req.url?.startsWith("/__control")) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (body?.fixture === "multi" || body?.fixture === "excellent") {
          pendingFixture = body.fixture;
          console.log(
            `[analyzer-stub] control: next fixture = ${pendingFixture}`,
          );
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, fixture: pendingFixture }));
          return;
        }
      } catch {
        // fall through to 400
      }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "invalid_fixture" } }));
    });
    return;
  }
  if (req.method === "POST" && req.url?.startsWith("/v1/analyses")) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      console.log(`[analyzer-stub] /v1/analyses -> ${pendingFixture}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(pendingFixture === "excellent" ? excellent : multi),
      );
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code: "not_found" } }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[analyzer-stub] listening on http://127.0.0.1:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => process.exit(0));
}
