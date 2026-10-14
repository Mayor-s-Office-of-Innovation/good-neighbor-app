// Executes the app matcher. Never derives capture time/site identity from filenames.
import { readdir, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { prepareImage } from "../src/analysis/duplicates/image-features.js";
import {
  createComparisonClient,
  rankImageCandidates,
  markUnassessedCandidates,
  matchImages,
  hashDistance,
  IMAGE_MATCHER_VERSION,
} from "../src/analysis/duplicates/image-matcher.js";
import { createAnalyzerClient } from "../src/analysis/analyzer-client.js";
import { adaptAssessment } from "../src/analysis/adapt-scorecard.js";

const args = process.argv.slice(2);
const option = (key) => args[args.indexOf(key) + 1];
const folder = args.includes("--folder")
  ? resolve(option("--folder"))
  : undefined;
if (!folder)
  throw new Error(
    "Specify --folder /path/to/images (real evidence stays outside Git)",
  );
const output = resolve(
  process.env.DUPLICATE_OUTPUT_DIR ||
    "/private/tmp/good-neighbor-duplicates-live",
);
const initialCandidates = args.includes("--initial-candidates")
  ? Number(option("--initial-candidates"))
  : undefined;
if (
  initialCandidates !== undefined &&
  (!Number.isInteger(initialCandidates) ||
    initialCandidates < 1 ||
    initialCandidates > 4)
)
  throw new Error("--initial-candidates must be 1–4");
const featuresOnly = args.includes("--features-only");
const assess = args.includes("--assess");
const maxCalls = args.includes("--max-calls")
  ? Number(option("--max-calls"))
  : 1000;
if (!Number.isInteger(maxCalls) || maxCalls < 0)
  throw new Error("Invalid --max-calls");
await mkdir(output, { recursive: true, mode: 0o700 });
for (const dir of ["images", "assessments", "comparisons"])
  await mkdir(join(output, dir), { recursive: true, mode: 0o700 });
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function save(path, value) {
  const temp = `${path}.tmp`;
  await writeFile(
    temp,
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
    { mode: 0o600 },
  );
  await rename(temp, path);
}
const files = (await readdir(folder))
  .filter((name) => /\.(jpg|jpeg|png|webp)$/i.test(name))
  .sort();
const sourceFolder = args.includes("--source-folder")
  ? resolve(option("--source-folder"))
  : undefined;
const candidateFolder = args.includes("--candidate-folder")
  ? resolve(option("--candidate-folder"))
  : undefined;
const candidateNames = candidateFolder
  ? (await readdir(candidateFolder))
      .filter((name) => /\.(jpg|jpeg|png|webp)$/i.test(name))
      .sort()
  : undefined;
if (
  candidateNames &&
  (!sourceFolder ||
    !candidateNames.length ||
    candidateNames.some((name) => !files.includes(name)))
)
  throw new Error(
    "Candidate folder requires source folder and images present in the corpus folder",
  );
const sourceNames = sourceFolder
  ? (await readdir(sourceFolder))
      .filter((name) => /\.(jpg|jpeg|png|webp)$/i.test(name))
      .sort()
  : undefined;
if (
  sourceNames &&
  (!sourceNames.length || sourceNames.some((name) => !files.includes(name)))
)
  throw new Error(
    "Source folder must contain images also present in the candidate folder",
  );
const candidatePolicy = sourceNames
  ? candidateNames
    ? "selected-sources-selected-candidates"
    : "selected-sources-all-candidates"
  : initialCandidates
    ? `initial-top-${initialCandidates}-visual-candidates`
    : "full-candidate-sweep";
if (sourceNames && initialCandidates)
  throw new Error("Source folder evaluation requires all candidates");
const resume = args.includes("--resume");
const previousResults = resume
  ? JSON.parse(await readFile(join(output, "results.json"), "utf8"))
  : [];
const previousInventory = resume
  ? JSON.parse(await readFile(join(output, "inventory.json"), "utf8"))
  : undefined;
const previousSummary = resume
  ? JSON.parse(await readFile(join(output, "summary.json"), "utf8"))
  : undefined;
const observations = [];
const failures = [];
let cachedAssessments = 0,
  assessmentCalls = 0,
  remoteCalls = 0,
  cacheHits = 0;
const analyzer =
  assess && process.env.ANALYZER_BASE_URL && process.env.ANALYZER_API_KEY
    ? createAnalyzerClient({
        baseUrl: process.env.ANALYZER_BASE_URL,
        apiKey: process.env.ANALYZER_API_KEY,
      })
    : undefined;
if (assess && !analyzer)
  throw new Error("--assess requires ANALYZER_BASE_URL and ANALYZER_API_KEY");
for (const [index, name] of files.entries()) {
  try {
    const bytes = await readFile(join(folder, name));
    if (
      candidateNames?.includes(name) &&
      digest(bytes) !== digest(await readFile(join(candidateFolder, name)))
    )
      throw new Error("Candidate image differs from corpus image");
    if (
      sourceNames?.includes(name) &&
      digest(bytes) !== digest(await readFile(join(sourceFolder, name)))
    )
      throw new Error("Source image differs from candidate-folder image");
    const contentType = /\.png$/i.test(name)
      ? "image/png"
      : /\.webp$/i.test(name)
        ? "image/webp"
        : "image/jpeg";
    const prepared = await prepareImage(bytes, contentType);
    const id = `I${String(index + 1).padStart(2, "0")}`;
    const observation = {
      id,
      revision: prepared.fingerprint,
      ...prepared,
      conditions: [],
    };
    await writeFile(
      join(output, "images", `${id}.jpg`),
      Buffer.from(prepared.image.base64, "base64"),
      { mode: 0o600 },
    );
    const cacheFile = join(output, "assessments", `${digest(bytes)}.json`);
    let cached;
    try {
      cached = JSON.parse(await readFile(cacheFile, "utf8"));
    } catch {}
    if (!cached && analyzer) {
      assessmentCalls++;
      try {
        // Service-required timestamp is evaluation time, NOT inferred capture time.
        const raw = await analyzer.analyze({
          metadata: {
            reported_at: new Date().toISOString(),
            latitude: 0,
            longitude: 0,
            position_descriptor:
              "local duplicate experiment; site and capture time unknown",
          },
          media: [{ type: "image", ...prepared.image }],
          requestId: `duplicate-eval-${id}`,
          appId: "good-neighbor-app",
        });
        cached = {
          evaluationOnly: true,
          captureTimeUnknown: true,
          inputHash: digest(bytes),
          raw,
          adapted: adaptAssessment(raw),
          evaluatedAt: new Date().toISOString(),
        };
        await save(cacheFile, cached);
      } catch (error) {
        failures.push({
          id,
          stage: "assessment",
          error: error.code || error.name || "assessment_failed",
        });
      }
    }
    if (cached) {
      cachedAssessments++;
      observation.conditions = cached.adapted.concerns
        .filter((c) => c.rating > 0)
        .map((c, i) => ({
          id: c.conditionId || `condition-${i}`,
          description: c.explanation,
          label: c.userFriendlyLabel || c.category,
        }));
    }
    observations.push({ ...observation, filename: name });
    console.info(
      `Prepared ${id} (${observations.length}/${files.length}); conditions ${observation.conditions.length}`,
    );
  } catch (error) {
    failures.push({
      filename: name,
      stage: "image",
      error: error.name || "preparation_failed",
    });
  }
}
const inventory = observations.map(({ image, ...rest }) => rest);
const selectedSources = sourceNames
  ? observations.filter((o) => sourceNames.includes(o.filename))
  : observations;
const candidatePool = candidateNames
  ? observations.filter((o) => candidateNames.includes(o.filename))
  : observations;
if (candidateNames && candidatePool.length !== candidateNames.length)
  throw new Error("Not all selected candidates could be prepared");
if (sourceNames && selectedSources.length !== sourceNames.length)
  throw new Error("Not all selected source images could be prepared");
if (resume) {
  const signature = (items) =>
    digest(
      JSON.stringify(
        items.map((item) => ({
          id: item.id,
          revision: item.revision,
          conditions: item.conditions,
        })),
      ),
    );
  if (
    previousSummary.candidatePolicy !== candidatePolicy ||
    JSON.stringify(previousSummary.candidateImages) !==
      JSON.stringify(
        candidateNames ? candidatePool.map((o) => o.id) : undefined,
      ) ||
    JSON.stringify(previousSummary.sourceImages) !==
      JSON.stringify(
        sourceNames ? selectedSources.map((o) => o.id) : undefined,
      ) ||
    signature(previousInventory.images) !== signature(inventory)
  )
    throw new Error(
      "Resume requires the same candidate policy and unchanged images/condition cache",
    );
}
await save(join(output, "inventory.json"), {
  images: inventory,
  failures,
  siteAndCaptureTimeUnknown: true,
});
const localPairs = [];
for (let i = 0; i < observations.length; i++)
  for (let j = 0; j < (sourceNames ? observations.length : i); j++) {
    if (
      sourceNames &&
      (!selectedSources.includes(observations[i]) ||
        !candidatePool.includes(observations[j]) ||
        i === j)
    )
      continue;
    const a = observations[i],
      b = observations[j];
    localPairs.push({
      source: a.id,
      candidate: b.id,
      identicalEvidence: a.fingerprint === b.fingerprint,
      hashDistance: hashDistance(a.perceptualHash, b.perceptualHash),
    });
  }
localPairs.sort((a, b) => a.hashDistance - b.hashDistance);
await save(join(output, "image-fingerprints.json"), {
  method: "normalized-image-sha256-and-dhash-v1",
  warning:
    "Hash similarity ranks evidence, not incident identity; no pair is excluded by distance.",
  pairs: localPairs,
});
const results = previousResults;
const compare =
  !featuresOnly &&
  process.env.DUPLICATE_ANALYZER_BASE_URL &&
  process.env.DUPLICATE_ANALYZER_API_KEY
    ? createComparisonClient({
        baseUrl: process.env.DUPLICATE_ANALYZER_BASE_URL,
        apiKey: process.env.DUPLICATE_ANALYZER_API_KEY,
      })
    : undefined;
if (!featuresOnly && !compare)
  console.info(
    "Live comparison unavailable: configure the isolated comparison endpoint/key. No duplicate verdicts will be fabricated.",
  );
if (compare) {
  const cachedCompare = async (request) => {
    const path = join(
      output,
      "comparisons",
      `${digest(JSON.stringify({ matcherVersion: IMAGE_MATCHER_VERSION, endpoint: process.env.DUPLICATE_ANALYZER_BASE_URL, request }))}.json`,
    );
    try {
      const cached = JSON.parse(await readFile(path, "utf8"));
      cacheHits++;
      return cached;
    } catch {}
    if (remoteCalls >= maxCalls)
      throw new Error("Comparison call budget exhausted");
    remoteCalls++;
    const response = await compare(request);
    await save(path, response);
    return response;
  };
  // Unordered folder experiment: compare each pair once. File order is NOT chronology.
  for (let index = 0; index < observations.length; index++) {
    if (!selectedSources.includes(observations[index])) continue;
    if (
      resume &&
      results.some(
        (row) =>
          row.sourceId === observations[index].id &&
          row.sourceRevision === observations[index].revision,
      )
    )
      continue;
    const allCandidates = sourceNames
      ? candidatePool.filter((o) => o.id !== observations[index].id)
      : observations.slice(0, index);
    const selectedCandidates = initialCandidates
      ? rankImageCandidates(observations[index], allCandidates).slice(
          0,
          initialCandidates,
        )
      : allCandidates;
    let result = await matchImages({
      source: observations[index],
      candidates: selectedCandidates,
      compare: cachedCompare,
      exhaustive: !initialCandidates,
    });
    if (initialCandidates)
      result = markUnassessedCandidates(result, allCandidates);
    results.push(result);
    await save(join(output, "results.json"), results);
    console.info(
      `Assessed ${result.sourceId}: ${result.status}; ${result.suggestions.length} issue suggestions`,
    );
    if (remoteCalls >= maxCalls) {
      console.info(
        "Stopping live run at comparison call budget; remaining pairs are unassessed.",
      );
      break;
    }
  }
}
const summary = {
  matcherVersion: IMAGE_MATCHER_VERSION,
  candidatePolicy,
  sourceImages: sourceNames ? selectedSources.map((o) => o.id) : undefined,
  candidateImages: candidateNames ? candidatePool.map((o) => o.id) : undefined,
  dataset: "user-selected image folder",
  completedAt: new Date().toISOString(),
  images: observations.length,
  unorderedPairs: localPairs.length,
  pairOrientation: sourceNames
    ? "selected-source-to-every-other-image"
    : "unordered-file-order",
  siteAndCaptureTimeUnknown: true,
  eligibilityReplayTested: false,
  featuresOnly,
  comparisonConfigured: Boolean(compare),
  assessmentCalls,
  cachedAssessments,
  cachedConditions: observations.reduce(
    (n, observation) => n + observation.conditions.length,
    0,
  ),
  remoteCalls,
  cacheHits,
  failures,
  completedSources: results.length,
  evaluatedPairs: results.reduce((n, r) => n + r.comparisons.length, 0),
  knownDuplicateLabelsUsed: false,
  failedSources: results
    .filter((row) => row.status === "failed")
    .map((row) => row.sourceId),
  failedCandidates: results.reduce(
    (total, row) => total + row.failedCandidateIds.length,
    0,
  ),
  visualSuggestions: results.flatMap((r) =>
    r.suggestions.map((s) => ({ sourceId: r.sourceId, ...s })),
  ),
  confidenceBands: Object.fromEntries(
    ["high", "medium", "low"].map((band) => [
      band,
      results.reduce(
        (n, r) => n + r.comparisons.filter((c) => c.confidence === band).length,
        0,
      ),
    ]),
  ),
};
await save(join(output, "summary.json"), summary);
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const evidenceHtml = (evidence) =>
  `<dl>${Object.entries(evidence)
    .map(
      ([key, value]) =>
        `<dt><strong>${escape(key.replaceAll("_", " "))}</strong></dt><dd>${Array.isArray(value) ? (value.length ? value.map(escape).join("; ") : "None recorded") : escape(value)}</dd>`,
    )
    .join("")}</dl>`;
const confidenceHtml = (item) =>
  `<p><strong>Confidence: ${escape(item.confidence)}</strong> — ${item.confidenceReasons.map(escape).join("; ")}</p>${evidenceHtml(item.evidence)}`;
const cards = summary.visualSuggestions
  .map(
    (r) =>
      `<section><h2>${escape(r.sourceId)} ↔ ${escape(r.candidate_id)}</h2><img src="images/${escape(r.sourceId)}.jpg"><img src="images/${escape(r.candidate_id)}.jpg"><p>${escape(r.reason)}</p>${confidenceHtml(r)}<ul>${r.condition_matches.map((m) => `<li>${escape(m.source_condition_id)} → ${escape(m.candidate_condition_id)}${confidenceHtml(m)}</li>`).join("")}</ul><p>Stage: ${escape(r.stage)}; visual evidence: ${escape(r.evidence_strength)}</p></section>`,
  )
  .join("");
const pending = results
  .flatMap((r) =>
    r.comparisons
      .filter(
        (c) => c.verdict === "uncertain" || c.evidence_strength === "tentative",
      )
      .map(
        (c) =>
          `<li>${escape(r.sourceId)} ↔ ${escape(c.candidate_id)}: ${escape(c.reason)}</li>`,
      ),
  )
  .join("");
const testedCandidates = `<details open><summary>Inspect tested candidates, failures, and unassessed counts</summary><table><tr><th>Source</th><th>Tested candidates and verdicts</th><th>Failed candidates</th><th>Unassessed candidates</th></tr>${results.map((result) => `<tr><td><a href="#${escape(result.sourceId)}">${escape(result.sourceId)}</a></td><td>${result.comparisons.map((row) => `<a href="#${escape(row.candidate_id)}">${escape(row.candidate_id)}</a>: ${escape(row.verdict)} / ${escape(row.evidence_strength)} (${escape(row.stage)})<details><summary>Confidence: ${escape(row.confidence)} — supporting evidence</summary><p>${escape(row.reason)}</p>${confidenceHtml(row)}${row.condition_matches.map((m) => `<p>${escape(m.source_condition_id)} → ${escape(m.candidate_condition_id)}</p>${confidenceHtml(m)}`).join("")}</details>`).join("<br>")}</td><td>${result.failedCandidateIds.map((id) => escape(id)).join(", ") || "—"}</td><td>${result.unassessedCandidateIds.length}</td></tr>`).join("")}</table></details>`;
const gallery = observations
  .map(
    (o) =>
      `<figure id="${escape(o.id)}"><img src="images/${escape(o.id)}.jpg"><figcaption>${escape(o.id)} — ${escape(o.filename)}<ul>${o.conditions.map((c) => `<li><strong>${escape(c.label || c.id)}</strong>: ${escape(c.description)}</li>`).join("")}</ul></figcaption></figure>`,
  )
  .join("");
await save(
  join(output, "review.html"),
  `<!doctype html><html><meta charset="utf-8"><title>Duplicate experiment review</title><style>body{font:16px system-ui;margin:32px;background:#f7f8fa;color:#182230}section{background:white;padding:16px;margin:20px 0}img{max-width:46%;max-height:420px;object-fit:contain}figure{display:inline-block;width:260px;vertical-align:top}figure img{max-width:100%;height:220px}figcaption{overflow-wrap:anywhere}pre{white-space:pre-wrap}td,th{padding:8px;text-align:left;vertical-align:top;border-bottom:1px solid #ddd}</style><h1>Backend image matcher review</h1><p>Image-first assessment. Known duplicates were withheld. No site/date eligibility is inferred from filenames.</p><p>${summary.images} images; ${summary.evaluatedPairs}/${summary.unorderedPairs} pairs assessed by the comparison backend; ${summary.remoteCalls} remote comparison calls; ${summary.assessmentCalls} assessment calls.</p>${compare ? "" : "<p><strong>Visual comparison has not run: comparison endpoint/key unavailable. Fingerprints are not duplicate verdicts.</strong></p>"}${initialCandidates ? `<p><strong>Initial pass: at most ${initialCandidates} top-ranked visual candidates per image. Unassessed candidates remain unknown; this is not a recall estimate or the production retrieval policy.</strong></p>` : ""}${sourceNames ? `<p>Selected sources: ${selectedSources.map((o) => escape(o.id)).join(", ")}; ${candidatePool.length} selected candidates. Every source/candidate pair is assessed.</p>` : ""}<p>Confidence bands are app policy, not calibrated probabilities. Medium suggestions require review and do not set duplicate flags. Missing capture/lifecycle history limits continuity confidence.</p><h2>Issue suggestions for review</h2>${cards || "<p>No recorded suggestions. Check completion and failures before interpreting this as a negative result.</p>"}<h2>Uncertain comparisons</h2><ul>${pending}</ul>${testedCandidates}<h2>All images (review missed matches)</h2>${gallery}<h2>Run details</h2><pre>${escape(JSON.stringify(summary, null, 2))}</pre></html>`,
);
console.info(`Review saved to ${join(output, "review.html")}`);
