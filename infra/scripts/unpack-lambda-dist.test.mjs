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
import { gzipSync } from "node:zlib";

const script = fileURLToPath(
  new URL("./unpack-lambda-dist.sh", import.meta.url),
);
const workflow = fileURLToPath(
  new URL("../../.github/workflows/plan-dev.yml", import.meta.url),
);

/**
 * Packs `files` into an archive, unpacks it into a fresh checkout and returns
 * what landed.
 * @param {(source: string) => void} files writes the archive's contents
 */
function unpack(files) {
  const directory = mkdtempSync(join(tmpdir(), "gn-unpack-test-"));
  const source = join(directory, "source");
  const checkout = join(directory, "checkout");
  mkdirSync(source);
  mkdirSync(join(checkout, "infra", "scripts"), { recursive: true });
  writeFileSync(join(checkout, "infra", "scripts", "plan-summary.jq"), "safe");
  files(source);
  const archive = join(directory, "lambda-dist.tgz");
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

/**
 * Builds a gzipped ustar archive byte by byte, since GNU tar strips a leading
 * `../` when it packs one.
 * @param {{ name: string, body?: string }[]} members a trailing `/` makes a folder
 */
function rawTar(members) {
  const blocks = members.flatMap(({ name, body = "" }) => {
    const header = Buffer.alloc(512);
    const dir = name.endsWith("/");
    const field = (/** @type {string} */ value, /** @type {number} */ at) =>
      header.write(value, at, "ascii");
    field(name, 0);
    field(dir ? "0000755\0" : "0000644\0", 100);
    field("0000000\0", 108);
    field("0000000\0", 116);
    field(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    field("00000000000\0", 136);
    field("        ", 148);
    field(dir ? "5" : "0", 156);
    field("ustar\0" + "00", 257);
    const sum = header.reduce((total, byte) => total + byte, 0);
    field(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    const data = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    data.write(body);
    return [header, data];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

test("refuses a member that climbs out with ..", () => {
  const directory = mkdtempSync(join(tmpdir(), "gn-unpack-test-"));
  try {
    // The script's staging folder sits in TMPDIR, so ../escaped lands here.
    const temp = join(directory, "tmp");
    const checkout = join(directory, "checkout");
    mkdirSync(temp);
    mkdirSync(checkout);
    const archive = join(directory, "lambda-dist.tgz");
    writeFileSync(
      archive,
      rawTar([
        { name: "backend/" },
        { name: "backend/dist/" },
        { name: "backend/dist/index.mjs", body: "code" },
        { name: "../escaped", body: "evil" },
      ]),
    );
    const list = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
    assert.match(
      list.stdout,
      /^\.\.\/escaped$/m,
      "archive lost its ../ member",
    );
    const result = spawnSync("bash", [script, archive, checkout], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: temp },
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(temp, "escaped")), false);
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
