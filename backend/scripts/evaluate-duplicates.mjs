import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  comparisonPrompt,
  evaluate,
  retrieveCandidates,
  validateDataset,
} from "../src/analysis/duplicates/experiment.js";

const { values } = parseArgs({
  options: {
    dataset: { type: "string" },
    predictions: { type: "string" },
    prompts: { type: "string" },
    split: { type: "string", default: "development" },
    thresholds: { type: "string", default: "0.25,0.35,0.5" },
  },
});

try {
  if (values.prompts && values.predictions) {
    throw new Error("Choose either prompt export or prediction evaluation.");
  }
  if (!["development", "test"].includes(values.split))
    throw new Error("--split must be development or test.");
  const thresholds = values.thresholds
    .split(",")
    .map((value) => (value.trim() ? Number(value) : NaN));
  if (
    !thresholds.length ||
    thresholds.some(
      (value) => !Number.isFinite(value) || value < 0 || value > 1,
    )
  )
    throw new Error("--thresholds must contain numbers from zero to one.");
  if (
    values.split === "test" &&
    thresholds.length !== 1 &&
    !values.predictions &&
    !values.prompts
  )
    throw new Error(
      "Freeze one development threshold before evaluating the test split.",
    );
  const dataset = validateDataset(
    JSON.parse(
      await readFile(
        values.dataset ??
          new URL(
            "../src/analysis/duplicates/fixtures/synthetic.json",
            import.meta.url,
          ),
        "utf8",
      ),
    ),
  );
  const cases = dataset.cases.filter((entry) => entry.split === values.split);
  if (!cases.length) throw new Error("Selected split has no cases.");
  if (values.prompts) {
    const prompts = cases.map((entry) => {
      const source = dataset.observations.find(
        (observation) => observation.id === entry.sourceId,
      );
      return {
        sourceId: source.id,
        ...comparisonPrompt(
          source,
          retrieveCandidates(source, dataset.observations),
        ),
      };
    });
    await writeFile(values.prompts, JSON.stringify(prompts, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      JSON.stringify({ promptsWritten: prompts.length, path: values.prompts }),
    );
  } else {
    let predictions;
    if (values.predictions) {
      const imported = JSON.parse(await readFile(values.predictions, "utf8"));
      if (!Array.isArray(imported))
        throw new Error(
          "Predictions must be an array of {sourceId, prediction}.",
        );
      predictions = new Map();
      for (const entry of imported) {
        if (
          !entry ||
          typeof entry.sourceId !== "string" ||
          predictions.has(entry.sourceId) ||
          !cases.some((testCase) => testCase.sourceId === entry.sourceId)
        )
          throw new Error("Unknown or duplicate prediction sourceId.");
        predictions.set(entry.sourceId, entry.prediction);
      }
    }
    const reports = (predictions ? [thresholds[0]] : thresholds).map(
      (threshold) =>
        evaluate(dataset, { threshold, split: values.split, predictions }),
    );
    console.log(JSON.stringify(reports, null, 2));
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Duplicate evaluation failed.",
  );
  process.exitCode = 1;
}
