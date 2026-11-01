import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Select the HTTPS tunnel for the local frontend, never an unrelated tunnel. */
export function ngrokOrigin(tunnels, frontendPort = "5173") {
  const origins = new Set();
  for (const tunnel of tunnels || []) {
    try {
      const upstream = new URL(tunnel.config?.addr);
      const publicUrl = new URL(tunnel.public_url);
      if (
        upstream.protocol === "http:" &&
        loopback.has(upstream.hostname) &&
        upstream.port === frontendPort &&
        publicUrl.protocol === "https:" &&
        !publicUrl.username &&
        !publicUrl.password &&
        publicUrl.pathname === "/" &&
        !publicUrl.search &&
        !publicUrl.hash
      )
        origins.add(publicUrl.origin);
    } catch {
      /* Ignore other or incomplete inspector entries. */
    }
  }
  if (origins.size !== 1)
    throw new Error(
      `Start one ngrok HTTPS tunnel to http://127.0.0.1:${frontendPort} before running dev:ngrok.`,
    );
  return [...origins][0];
}

/** This launcher is exclusively for the local MinIO-backed harness. */
export function requireLocalStorage(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    /* Report one actionable error below. */
  }
  if (
    !url ||
    url.protocol !== "http:" ||
    !loopback.has(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error(
      "dev:ngrok requires AWS_ENDPOINT_URL_S3 to point to local MinIO over HTTP.",
    );
}

async function main() {
  requireLocalStorage(process.env.AWS_ENDPOINT_URL_S3);
  const response = await fetch("http://127.0.0.1:4040/api/tunnels", {
    signal: AbortSignal.timeout(5000),
  }).catch(() => {
    throw new Error(
      "Cannot reach the local ngrok inspector. Start ngrok http http://127.0.0.1:5173 first.",
    );
  });
  if (!response.ok)
    throw new Error("The local ngrok inspector could not list tunnels.");
  const origin = ngrokOrigin((await response.json()).tunnels);
  console.log(`Local device-test upload origin: ${origin}`);
  // Environment is inherited by the local API and workers. Their --env-file
  // loading preserves this explicit value; nothing is written to .env.local.
  const child = spawn("npm", ["run", "dev", "--workspace", "backend"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, S3_PUBLIC_PRESIGN_ENDPOINT: origin },
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => child.kill(signal));
  child.once("error", () => {
    console.error("Could not start the local backend.");
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
