#!/usr/bin/env node
/*
  List candidate user-facing English literals still present in source files, so
  an extraction pass can confirm it is complete.

    node scripts/i18n-literals.mjs src/components/foo.js [more files]

  Heuristic, not exact: prints quoted strings that look like prose (start with a
  capital letter or contain a space and letters) and template-literal text nodes
  / label-like attributes. Ignores comments, console.* lines, import paths, and
  strings that are obviously identifiers. Review the output by eye.
*/
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
if (!files.length) throw new Error("Usage: i18n-literals.mjs <file...>");
const prose =
  /^(?=.*[a-zA-Z])(?!.*[=<>{}\/\\])(?:[A-Z][^\n]{2,}|[^\n]*\s[^\n]*)$/;
const ATTRS =
  /(?:aria-label|aria-description|placeholder|title|alt|label|hint|help-text|value)="([^"$]{3,})"/g;

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  const hits = [];
  lines.forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, "");
    if (/^\s*(\*|\/\*|import |console\.|export \* |\/\/)/.test(raw)) return;
    if (/console\.(warn|error|info|log|debug)\(/.test(line)) return;
    for (const m of line.matchAll(/(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
      const v = m[2];
      const before = line.slice(0, m.index);
      if (
        /(class|rel|href|src|name|id|data-[a-z-]+|type|role|method|for)=$/.test(
          before,
        )
      )
        continue;
      if (v.length > 2 && prose.test(v) && !/^[a-z-]+:[a-z-]+$/.test(v))
        hits.push([i + 1, v]);
    }
    for (const m of line.matchAll(/>([^<>$`]*[A-Za-z]{3,}[^<>$`]*)</g)) {
      const v = m[1].trim();
      if (v && !/^[A-Z_]+$/.test(v)) hits.push([i + 1, v]);
    }
    // Text node that spans the whole line inside a template (e.g. "   Send feedback")
    if (
      /^\s+[A-Z][a-zA-Z'’,.!?:()\- ]{2,}$/.test(raw) &&
      !/^\s+[A-Z][A-Z_]+$/.test(raw.trim())
    ) {
      hits.push([i + 1, raw.trim()]);
    }
    for (const m of line.matchAll(ATTRS)) hits.push([i + 1, `[attr] ${m[1]}`]);
  });
  console.log(`\n## ${file}: ${hits.length} candidate(s)`);
  for (const [n, v] of hits) console.log(`${String(n).padStart(5)}  ${v}`);
}
