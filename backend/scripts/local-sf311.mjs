// Local fake for SF311 HUB/Verint CreateSR/UpdateSR. It records payloads and
// returns HUB-shaped success responses without making any external requests.

import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.LOCAL_SF311_PORT ?? 3999);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(
  process.env.LOCAL_SF311_LOG_PATH ??
    resolve(SCRIPT_DIR, "../.local/sf311-requests.jsonl"),
);

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
};

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolveBody, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  res.writeHead(status, {
    ...CORS_HEADERS,
    "content-type": "application/json",
  });
  res.end(JSON.stringify(body, null, 2));
}

/**
 * @returns {Promise<unknown[]>}
 */
async function readRequests() {
  try {
    const text = await readFile(LOG_PATH, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * @param {unknown} entry
 */
async function appendRequest(entry) {
  await mkdir(dirname(LOG_PATH), { recursive: true });
  await writeFile(LOG_PATH, `${JSON.stringify(entry)}\n`, { flag: "a" });
}

/**
 * @param {number} number
 * @returns {string}
 */
function fakeSrNumber(number) {
  return `LOCAL-SR-${String(number).padStart(6, "0")}`;
}

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (method === "OPTIONS") {
    res.writeHead(204, {
      ...CORS_HEADERS,
      "access-control-max-age": "86400",
    });
    res.end();
    return;
  }

  try {
    if (method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "fake-sf311" });
      return;
    }

    if (method === "GET" && url.pathname === "/requests") {
      sendJson(res, 200, { requests: await readRequests() });
      return;
    }

    if (method === "DELETE" && url.pathname === "/requests") {
      await rm(LOG_PATH, { force: true });
      sendJson(res, 200, { ok: true, cleared: LOG_PATH });
      return;
    }

    if (method === "GET" && url.pathname.includes("lookup")) {
      sendJson(res, 200, {
        data: [
          { NatureofRequest: "1.1.4.7.20.0", ResponsibleAgency: "76" },
          { NatureofRequest: "1.1.4.7.9.0", ResponsibleAgency: "76" },
          { NatureofRequest: "1.1.4.7.12.0", ResponsibleAgency: "76" },
          { NatureofRequest: "1.1.4.7.15.0", ResponsibleAgency: "76" },
          { NatureofRequest: "1.23.1.1.1.0", ResponsibleAgency: "76" },
        ],
      });
      return;
    }

    if (method === "POST" && url.pathname.includes("updatesr")) {
      const bodyText = await readBody(req);
      const payload = bodyText ? JSON.parse(bodyText) : {};
      const priorRequests = await readRequests();
      const updateId = priorRequests.length + 1;
      const entry = {
        receivedAt: new Date().toISOString(),
        kind: "updatesr",
        method,
        path: url.pathname,
        authorizationPresent: Boolean(req.headers.authorization),
        payload,
        response: { UpdateID: updateId },
      };
      await appendRequest(entry);
      console.log(
        `[sf311] update sr=${payload.SRnum ?? payload.SRNum ?? "unknown"} ` +
          `type=${payload.UpdateType ?? "unknown"} update=${updateId}`,
      );
      sendJson(res, 200, {
        UpdateID: updateId,
        error_description: "",
        return_code: 0,
      });
      return;
    }

    if (method === "POST") {
      const bodyText = await readBody(req);
      const payload = bodyText ? JSON.parse(bodyText) : {};
      const priorRequests = await readRequests();
      const srNum = fakeSrNumber(priorRequests.length + 1);
      const entry = {
        receivedAt: new Date().toISOString(),
        kind: "createsr",
        method,
        path: url.pathname,
        authorizationPresent: Boolean(req.headers.authorization),
        payload,
        response: { SRNum: srNum },
      };
      await appendRequest(entry);
      console.log(
        `[sf311] ${payload.NatureofRequest ?? "unknown"} ` +
          `agency=${payload.ResponsibleAgency ?? ""} sr=${srNum}`,
      );
      sendJson(res, 200, {
        data: {
          return_code: "0",
          return_message: "Local fake CreateSR success",
          SRNum: srNum,
        },
      });
      return;
    }

    sendJson(res, 404, { error: "not found", method, path: url.pathname });
  } catch (error) {
    console.error("[sf311] request failed:", error);
    sendJson(res, 500, { error: "local fake sf311 error" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[sf311] fake server listening on http://127.0.0.1:${PORT}`);
  console.log(`[sf311] CreateSR URL: http://127.0.0.1:${PORT}/createsr`);
  console.log(`[sf311] UpdateSR URL: http://127.0.0.1:${PORT}/updatesr`);
  console.log(`[sf311] lookup URL:   http://127.0.0.1:${PORT}/lookup`);
  console.log(`[sf311] requests:     http://127.0.0.1:${PORT}/requests`);
  console.log(`[sf311] log file:     ${LOG_PATH}`);
});
