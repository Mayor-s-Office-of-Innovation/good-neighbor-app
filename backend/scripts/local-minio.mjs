// Launches MinIO (an S3-compatible server) for the local dev harness — the local
// stand-in for S3 so the presigned-PUT upload leg and the analyze worker's
// getObjectBytes read-back work without real AWS. There's no maintained npm
// helper, so — exactly like local-mq.mjs does for ElasticMQ — we download the
// official single binary into backend/.local/ (git-ignored) on first run, then
// spawn it. Stays in the foreground under `concurrently`; kills the child on
// SIGINT/SIGTERM so ports 9000/9001 aren't orphaned.
//
// Root credentials are taken from the SAME AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
// the AWS SDK uses (loaded via --env-file), so one shared S3 client authenticates
// against MinIO. MinIO requires user >= 3 chars and password >= 8 chars, so those
// env values must satisfy that (see .env.example).

import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API_PORT = Number(process.env.LOCAL_MINIO_API_PORT ?? 9000);
const CONSOLE_PORT = Number(process.env.LOCAL_MINIO_CONSOLE_PORT ?? 9001);

const backendDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const localDir = join(backendDir, ".local");
const binPath = join(localDir, "minio");
const dataDir = join(localDir, "minio-data");

/**
 * @returns {Promise<string | null>}
 */
async function installedBinary() {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-lc", "command -v minio"], (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

/**
 * Map Node's platform/arch to MinIO's release path segment (`<os>-<arch>`).
 * MinIO uses `amd64` where Node reports `x64`.
 * @returns {string}
 */
function releaseTarget() {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(
      `Unsupported platform "${process.platform}" for the MinIO harness (macOS/Linux only).`,
    );
  }
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return `${os}-${arch}`;
}

async function ensureBinary() {
  try {
    await stat(binPath);
    return; // already downloaded
  } catch {
    // fall through to download
  }
  await mkdir(localDir, { recursive: true });
  // Latest stable server binary for this OS/arch. MinIO's S3 API is stable, so
  // the harness tracks latest rather than pinning a RELEASE.<ts> archive URL.
  const url = `https://dl.min.io/server/minio/release/${releaseTarget()}/minio`;
  console.log(`[minio] downloading MinIO (${releaseTarget()})…`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: ${res.status} ${res.statusText}`);
  }
  await pipeline(
    /** @type {any} */ (Readable.fromWeb(res.body)),
    createWriteStream(binPath),
  );
  await chmod(binPath, 0o755);
  console.log(`[minio] saved ${binPath}`);
}

async function main() {
  const rootUser = process.env.AWS_ACCESS_KEY_ID;
  const rootPassword = process.env.AWS_SECRET_ACCESS_KEY;
  if (!rootUser || !rootPassword) {
    throw new Error(
      "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY must be set (MinIO root creds). Did the --env-file load?",
    );
  }

  const installed = await installedBinary();
  const minioBin = installed ?? binPath;
  if (!installed) await ensureBinary();
  await mkdir(dataDir, { recursive: true });
  console.log(
    `[minio] starting MinIO on :${API_PORT} (console :${CONSOLE_PORT}) with ${minioBin}…`,
  );

  const child = spawn(
    minioBin,
    [
      "server",
      dataDir,
      // Bind to loopback (like elasticmq.conf) so macOS doesn't prompt to accept
      // incoming network connections.
      "--address",
      `127.0.0.1:${API_PORT}`,
      "--console-address",
      `127.0.0.1:${CONSOLE_PORT}`,
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        MINIO_ROOT_USER: rootUser,
        MINIO_ROOT_PASSWORD: rootPassword,
        // Belt-and-suspenders CORS for the browser's cross-origin presigned PUT
        // (the bucket also gets an explicit CORS rule in ensure-infra.mjs).
        MINIO_API_CORS_ALLOW_ORIGIN: "*",
      },
    },
  );

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[minio] ${signal} received, stopping MinIO…`);
    child.kill("SIGTERM");
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  child.on("exit", (code) => {
    console.log(`[minio] MinIO exited (${code ?? "signal"})`);
    process.exit(code ?? 0);
  });
  child.on("error", (err) => {
    console.error("[minio] failed to start:", err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error("[minio] failed to start:", err);
  process.exit(1);
});
