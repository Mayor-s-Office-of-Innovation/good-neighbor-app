// Launches ElasticMQ (an SQS-compatible Java jar). There's no maintained npm
// helper for the server, so we download the official fat jar from the
// softwaremill GitHub release into backend/.local/ (git-ignored) on first run,
// then spawn `java -jar`. Stays in the foreground under `concurrently`; kills the
// jar on SIGINT/SIGTERM so port 9324 isn't orphaned.
//
// Requires a JVM (11+; 17+ is fine and is what DynamoDB Local needs anyway).

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ELASTICMQ_VERSION = "1.7.1";
const JAR_NAME = `elasticmq-server-all-${ELASTICMQ_VERSION}.jar`;
const JAR_URL = `https://github.com/softwaremill/elasticmq/releases/download/v${ELASTICMQ_VERSION}/${JAR_NAME}`;

const backendDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const localDir = join(backendDir, ".local");
const jarPath = join(localDir, JAR_NAME);
const confPath = join(backendDir, "elasticmq.conf");

async function ensureJar() {
  try {
    await stat(jarPath);
    return; // already downloaded
  } catch {
    // fall through to download
  }
  await mkdir(localDir, { recursive: true });
  console.log(`[mq] downloading ElasticMQ ${ELASTICMQ_VERSION}…`);
  const res = await fetch(JAR_URL, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: ${res.status} ${res.statusText}`);
  }
  await pipeline(
    /** @type {any} */ (Readable.fromWeb(res.body)),
    createWriteStream(jarPath),
  );
  console.log(`[mq] saved ${jarPath}`);
}

async function main() {
  await ensureJar();
  console.log("[mq] starting ElasticMQ on :9324…");

  const child = spawn("java", [`-Dconfig.file=${confPath}`, "-jar", jarPath], {
    stdio: "inherit",
  });

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[mq] ${signal} received, stopping ElasticMQ…`);
    child.kill("SIGTERM");
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  child.on("exit", (code) => {
    console.log(`[mq] ElasticMQ exited (${code ?? "signal"})`);
    process.exit(code ?? 0);
  });
  child.on("error", (err) => {
    if (/** @type {{ code?: string }} */ (err).code === "ENOENT") {
      console.error(
        "[mq] `java` not found. Install a JRE 17+ (e.g. `brew install --cask temurin`).",
      );
    } else {
      console.error("[mq] failed to start:", err);
    }
    process.exit(1);
  });
}

main().catch((err) => {
  console.error("[mq] failed to start:", err);
  process.exit(1);
});
