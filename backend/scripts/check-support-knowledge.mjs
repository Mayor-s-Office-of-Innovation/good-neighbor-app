import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sources } from "../src/support/knowledge.js";

const root = new URL("../../", import.meta.url);
const provenance = JSON.parse(
  readFileSync(
    new URL("../src/support/knowledge-provenance.json", import.meta.url),
    "utf8",
  ),
);
let failed = false;
for (const [path, expected] of Object.entries(provenance.behaviorFiles)) {
  const actual = createHash("sha256")
    .update(readFileSync(new URL(path, root)))
    .digest("hex");
  if (actual !== expected) {
    failed = true;
    console.error(
      `Support knowledge review needed: ${path}. Review the affected FAQ/guide, then update its provenance hash. See docs/runbooks/support-chat.md.`,
    );
  }
}
if (
  new Set(sources.map(({ id }) => id)).size !== sources.length ||
  sources.some(({ id, title, text }) => !id || !title || !text)
)
  failed = true;
if (JSON.stringify(sources).length > 55000) {
  failed = true;
  console.error(
    "Support knowledge exceeds the 55,000-character bundle budget; review before expanding inference cost.",
  );
}
if (failed) process.exitCode = 1;
else
  console.log(
    `Support knowledge checked (${sources.length} sources; ${fileURLToPath(root)}).`,
  );
