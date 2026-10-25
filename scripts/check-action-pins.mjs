import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { load, JSON_SCHEMA } from "js-yaml";

// Parse YAML rather than scanning lines: quoted keys, flow mappings, aliases,
// and multiline scalars must not bypass the policy or match shell script text.
export function checkWorkflowPins(source, file = "workflow") {
  const workflow = load(source, { schema: JSON_SCHEMA });
  if (!workflow?.jobs || typeof workflow.jobs !== "object") {
    throw new Error(`${file}: expected a workflow with jobs`);
  }
  const errors = [];
  function check(node, location) {
    if (!node || !Object.hasOwn(node, "uses")) return;
    const reference = node.uses;
    const valid =
      typeof reference === "string" &&
      (reference.startsWith("./") ||
        /^docker:\/\/[^\s@]+@sha256:[a-f0-9]{64}$/.test(reference) ||
        /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[a-f0-9]{40}$/.test(reference));
    if (!valid) {
      errors.push(
        `${file}:${location}: ${JSON.stringify(reference)} must use a full commit SHA (or a Docker SHA-256 digest); local ./ references are allowed.`,
      );
    }
  }
  for (const [name, job] of Object.entries(workflow.jobs)) {
    check(job, `jobs.${name}.uses`);
    for (const [index, step] of (job.steps ?? []).entries()) {
      check(step, `jobs.${name}.steps[${index}].uses`);
    }
  }
  return errors;
}

export async function checkActionPins(root = process.cwd()) {
  const directory = resolve(root, ".github/workflows");
  const files = (await readdir(directory)).filter((name) =>
    /\.ya?ml$/.test(name),
  );
  if (!files.length) throw new Error("No workflow files found");
  const errors = [];
  for (const file of files.sort()) {
    errors.push(
      ...checkWorkflowPins(
        await readFile(resolve(directory, file), "utf8"),
        `.github/workflows/${file}`,
      ),
    );
  }
  return errors;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const errors = await checkActionPins();
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
    } else {
      console.log("All workflow action references are pinned.");
    }
  } catch (error) {
    console.error("Workflow action pin check failed:", error.message);
    process.exitCode = 1;
  }
}
