import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./unpack-lambda-dist.sh", import.meta.url),
);
const workflow = fileURLToPath(
  new URL("../../.github/workflows/plan-dev.yml", import.meta.url),
);
const bsdtar = /bsdtar/.test(
  spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout,
);

/**
 * Packs `files` into an archive, unpacks it into a fresh checkout and returns
 * what landed.
 * @param {(source: string) => void} files writes the archive's contents
 * @param {string[]} [tarArgs] extra flags for the packing tar
 */
function unpack(files, tarArgs = []) {
  const directory = mkdtempSync(join(tmpdir(), "gn-unpack-test-"));
  const source = join(directory, "source");
  const checkout = join(directory, "checkout");
  mkdirSync(source);
  mkdirSync(join(checkout, "infra", "scripts"), { recursive: true });
  writeFileSync(join(checkout, "infra", "scripts", "plan-summary.jq"), "safe");
  files(source);
  const archive = join(directory, "lambda-dist.tgz");
  const pack = spawnSync(
    "tar",
    ["-czf", archive, ...tarArgs, "-C", source, "."],
    { encoding: "utf8" },
  );
  assert.equal(pack.status, 0, pack.stderr);
  const result = spawnSync("bash", [script, archive, checkout], {
    encoding: "utf8",
  });
  return { result, checkout, directory };
}

/** @param {string} source */
function bundle(source) {
  mkdirSync(join(source, "backend", "dist", "api"), { recursive: true });
  writeFileSync(join(source, "backend", "dist", "api", "index.mjs"), "code");
}

test("unpacks the bundles and keeps their file modes", () => {
  const { result, checkout, directory } = unpack((source) => {
    bundle(source);
    writeFileSync(join(source, "backend", "dist", "api", "run"), "x", {
      mode: 0o755,
    });
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    const dist = join(checkout, "backend", "dist", "api");
    assert.equal(readFileSync(join(dist, "index.mjs"), "utf8"), "code");
    assert.equal(statSync(join(dist, "run")).mode & 0o777, 0o755);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses an archive that would replace the plan's jq filter", () => {
  const { result, checkout, directory } = unpack((source) => {
    bundle(source);
    mkdirSync(join(source, "infra", "scripts"), { recursive: true });
    writeFileSync(join(source, "infra", "scripts", "plan-summary.jq"), "evil");
  });
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside backend\/dist/);
    const jq = join(checkout, "infra", "scripts", "plan-summary.jq");
    assert.equal(readFileSync(jq, "utf8"), "safe");
    assert.equal(existsSync(join(checkout, "backend", "dist")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses a symlink inside backend/dist", () => {
  const { result, checkout, directory } = unpack((source) => {
    bundle(source);
    symlinkSync("../../../infra", join(source, "backend", "dist", "infra"));
  });
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /link or special file/);
    assert.equal(existsSync(join(checkout, "backend", "dist")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses a member that climbs out with ..", () => {
  const rename = bsdtar
    ? ["-s", ",^\\./backend/dist/api/index.mjs$,../escaped,"]
    : ["--transform", "s,^\\./backend/dist/api/index.mjs$,../escaped,"];
  const { result, checkout, directory } = unpack(bundle, rename);
  try {
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(checkout, "escaped")), false);
    assert.equal(existsSync(join(directory, "escaped")), false);
    assert.equal(existsSync(join(checkout, "backend", "dist")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("plan-dev.yml downloads outside the checkout and unpacks only through the script", () => {
  const text = readFileSync(workflow, "utf8");
  const download = text.match(
    /uses: actions\/download-artifact@[\s\S]*?path: (.+)/,
  );
  assert.ok(download, "no download-artifact step");
  assert.match(download[1], /runner\.temp/);
  assert.doesNotMatch(text, /tar -x/);
  assert.match(text, /infra\/scripts\/unpack-lambda-dist\.sh/);
});
