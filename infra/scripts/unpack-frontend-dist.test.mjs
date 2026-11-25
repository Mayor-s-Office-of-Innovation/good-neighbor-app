import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./unpack-frontend-dist.sh", import.meta.url),
);
const workflow = fileURLToPath(
  new URL("../../.github/workflows/deploy.yml", import.meta.url),
);

/**
 * Packs `files` into an archive, unpacks it into a fresh checkout and returns
 * what landed.
 * @param {(source: string) => void} files writes the archive's contents
 */
function unpack(files) {
  const directory = mkdtempSync(join(tmpdir(), "gn-frontend-unpack-test-"));
  const source = join(directory, "source");
  const checkout = join(directory, "checkout");
  mkdirSync(source);
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  writeFileSync(join(checkout, "scripts", "publish-web-assets.sh"), "safe");
  files(source);
  const archive = join(directory, "frontend-dist.tgz");
  const pack = spawnSync("tar", ["-czf", archive, "-C", source, "."], {
    encoding: "utf8",
  });
  assert.equal(pack.status, 0, pack.stderr);
  const result = spawnSync("bash", [script, archive, checkout], {
    encoding: "utf8",
  });
  return { result, checkout, directory };
}

/** @param {string} source */
function bundle(source) {
  mkdirSync(join(source, "frontend", "dist", "assets"), { recursive: true });
  writeFileSync(
    join(source, "frontend", "dist", "index.html"),
    "<html></html>",
  );
  writeFileSync(
    join(source, "frontend", "dist", "assets", "app.js"),
    "console.log(1);",
  );
}

test("unpacks frontend/dist regular files cleanly", () => {
  const { result, checkout, directory } = unpack(bundle);
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(join(checkout, "frontend", "dist", "index.html"), "utf8"),
      "<html></html>",
    );
    assert.equal(
      readFileSync(
        join(checkout, "frontend", "dist", "assets", "app.js"),
        "utf8",
      ),
      "console.log(1);",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses an archive with files outside frontend/dist", () => {
  const { result, checkout, directory } = unpack((source) => {
    bundle(source);
    mkdirSync(join(source, "scripts"), { recursive: true });
    writeFileSync(join(source, "scripts", "publish-web-assets.sh"), "evil");
  });
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside frontend\/dist/);
    assert.equal(
      readFileSync(join(checkout, "scripts", "publish-web-assets.sh"), "utf8"),
      "safe",
    );
    assert.equal(existsSync(join(checkout, "frontend", "dist")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses a symlink inside frontend/dist", () => {
  const { result, checkout, directory } = unpack((source) => {
    bundle(source);
    symlinkSync(
      "../../../scripts",
      join(source, "frontend", "dist", "scripts"),
    );
  });
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /link or special file/);
    assert.equal(existsSync(join(checkout, "frontend", "dist")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deploy.yml isolates @posthog/cli outside the AWS-credentialed job", () => {
  const text = readFileSync(workflow, "utf8");
  const uncommented = text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const splitIdx = uncommented.indexOf("\n  terraform-apply:");
  assert.ok(splitIdx > 0, "expected build-frontend before terraform-apply");
  const buildSection = uncommented.slice(0, splitIdx);
  const deploySection = uncommented.slice(splitIdx);

  assert.doesNotMatch(buildSection, /id-token:\s*write/);
  assert.doesNotMatch(buildSection, /configure-aws-credentials/);
  assert.match(buildSection, /@posthog\/cli/);

  assert.match(deploySection, /needs:\s*build-frontend/);
  assert.match(deploySection, /id-token:\s*write/);
  assert.doesNotMatch(deploySection, /@posthog\/cli/);

  const download = deploySection.match(
    /uses: actions\/download-artifact@[\s\S]*?path: (.+)/,
  );
  assert.ok(download, "expected download-artifact in terraform-apply");
  assert.match(download[1], /runner\.temp/);
  assert.match(deploySection, /infra\/scripts\/unpack-frontend-dist\.sh/);
});

test("deploy callers serialize whole runs on a group distinct from the job lock", () => {
  for (const environment of ["dev", "prod"]) {
    const text = readFileSync(
      fileURLToPath(
        new URL(
          `../../.github/workflows/deploy-${environment}.yml`,
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // Top-level (unindented) concurrency, so build-frontend is inside the lock.
    const block = text.match(/^concurrency:\n((?: {2}.*\n)+)/m);
    assert.ok(
      block,
      `deploy-${environment}.yml needs workflow-level concurrency`,
    );
    assert.match(block[1], new RegExp(`group: deploy-run-${environment}\\s`));
    assert.match(block[1], /cancel-in-progress: false/);
    // The same group at workflow and job level deadlocks and GitHub cancels.
    assert.doesNotMatch(
      block[1],
      new RegExp(`group: deploy-${environment}\\s`),
    );
  }
});
