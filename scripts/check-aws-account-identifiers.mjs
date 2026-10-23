import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Scan tracked and non-ignored files, including hidden files, without requiring rg.
export async function scanAccountIdentifiers(root = process.cwd(), files) {
  files ??= execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const matches = [];
  for (const file of new Set(files)) {
    const path = resolve(root, file);
    if (!(await lstat(path)).isFile()) continue;
    const bytes = await readFile(path);
    if (bytes.includes(0)) continue;
    const lines = bytes.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      // Numeric UUID segments are identifiers, not standalone account literals.
      const text = lines[i].replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        "UUID",
      );
      if (/(?<![A-Za-z0-9_.])[0-9]{12}(?![A-Za-z0-9_])/.test(text))
        matches.push(`${file}:${i + 1}`);
    }
  }
  return matches;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const matches = await scanAccountIdentifiers();
    if (matches.length) {
      console.error(matches.join("\n"));
      console.error(
        "Literal AWS account identifiers are prohibited; use environment configuration.",
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("AWS account identifier scan failed:", error.message);
    process.exitCode = 1;
  }
}
