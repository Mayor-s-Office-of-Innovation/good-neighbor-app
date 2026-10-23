import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanAccountIdentifiers } from "./check-aws-account-identifiers.mjs";

test("detects literal identifiers, including hidden files, without printing their values", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-guard-"));
  try {
    const account = "123456" + "789012";
    await writeFile(
      join(root, ".config"),
      `arn:aws:iam::${account}:role/test\n${account}\n`,
    );
    await writeFile(
      join(root, "safe"),
      `a${account}\n_${account}\n.${account}\n${account}x\n${account}_\n${account}3`,
    );
    const uuid = `11111111-1111-4111-8111-${account}`;
    await writeFile(
      join(root, "uuid"),
      `${uuid}\n${uuid} arn:aws:iam::${account}:role/test`,
    );
    assert.deepEqual(await scanAccountIdentifiers(root, ["uuid"]), ["uuid:2"]);
    await writeFile(join(root, "binary"), Buffer.from(`\0${account}`));
    assert.deepEqual(
      await scanAccountIdentifiers(root, [".config", "safe", "binary"]),
      [".config:1", ".config:2"],
    );
    await assert.rejects(scanAccountIdentifiers(root, ["missing"]), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI fails on scan errors and matches, and honors Git ignore rules", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const script = fileURLToPath(
    new URL("./check-aws-account-identifiers.mjs", import.meta.url),
  );
  const root = await mkdtemp(join(tmpdir(), "account-guard-cli-"));
  const run = () =>
    spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  try {
    assert.equal(run().status, 1);
    assert.equal(spawnSync("git", ["init", "--quiet", root]).status, 0);
    const account = "123456" + "789012";
    await writeFile(join(root, ".gitignore"), "ignored\n");
    await writeFile(join(root, "ignored"), account);
    assert.equal(run().status, 0);
    await writeFile(join(root, ".config"), account);
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.config:1/);
    assert.ok(!result.stderr.includes(account));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
