#!/usr/bin/env node

import net from "node:net";
import tls from "node:tls";
import { randomUUID } from "node:crypto";

const required = ["SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_TO"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(
    `Missing required environment variables: ${missing.join(", ")}`,
  );
  process.exit(1);
}

const host = process.env.SMTP_HOST;
const port = 587;
const username = process.env.SMTP_USERNAME;
const password = process.env.SMTP_PASSWORD;
const recipient = process.env.SMTP_TO;
const sender = "goodneighbor-dev@sf.gov";

if (process.env.SMTP_FROM && process.env.SMTP_FROM !== sender) {
  console.error(`This dev-only probe only permits ${sender} as SMTP_FROM.`);
  process.exit(1);
}

if (!/^\S+@\S+$/.test(recipient)) {
  console.error("SMTP_TO must be a single email address.");
  process.exit(1);
}

const timeoutMs = 10_000;

/** @param {net.Socket | tls.TLSSocket} socket */
function smtpReader(socket) {
  let buffer = "";
  /** @type {Array<{resolve: (value: string[]) => void, reject: (reason: Error) => void, timer: NodeJS.Timeout}>} */
  const waiting = [];

  const onData = (chunk) => {
    // Keep the underlying socket in binary mode. The same socket is handed to
    // tls.connect() after STARTTLS, and setting a text encoding on it would
    // corrupt the TLS records before the TLS wrapper can process them.
    buffer += chunk.toString("utf8");
    while (true) {
      const match = /(?:^|\r\n)(\d{3}) ([^\r\n]*)\r\n/.exec(buffer);
      if (!match) break;
      const end = match.index + match[0].length;
      const response = buffer.slice(0, end).trim().split("\r\n");
      buffer = buffer.slice(end);
      const next = waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(response);
      }
    }
  };
  const onError = (error) => {
    waiting.splice(0).forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(error);
    });
  };
  socket.on("data", onData);
  socket.on("error", onError);

  return {
    read: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiting.findIndex((item) => item.timer === timer);
          if (index >= 0) waiting.splice(index, 1);
          reject(new Error("SMTP response timed out"));
        }, timeoutMs);
        waiting.push({ resolve, reject, timer });
      }),
    dispose: () => {
      socket.off("data", onData);
      socket.off("error", onError);
    },
  };
}

/** @param {net.Socket | tls.TLSSocket} socket @param {() => Promise<string[]>} read @param {string} command @param {number[]} expected */
async function exchange(socket, read, command, expected) {
  socket.write(`${command}\r\n`);
  const lines = await read();
  const status = Number(lines.at(-1)?.slice(0, 3));
  if (!expected.includes(status)) {
    throw new Error(`SMTP command failed with status ${status}`);
  }
}

const plain = net.createConnection({ host, port });
plain.setTimeout(timeoutMs, () =>
  plain.destroy(new Error("SMTP connection timed out")),
);
let reader = smtpReader(plain);

try {
  const greeting = await reader.read();
  if (Number(greeting.at(-1)?.slice(0, 3)) !== 220)
    throw new Error("SMTP greeting failed");
  await exchange(plain, reader.read, "EHLO good-neighbor-dev", [250]);
  await exchange(plain, reader.read, "STARTTLS", [220]);
  reader.dispose();

  const secure = tls.connect({
    socket: plain,
    servername: host,
    minVersion: "TLSv1.2",
  });
  await new Promise((resolve, reject) => {
    secure.once("secureConnect", resolve);
    secure.once("error", reject);
  });
  reader = smtpReader(secure);
  await exchange(secure, reader.read, "EHLO good-neighbor-dev", [250]);
  await exchange(secure, reader.read, "AUTH LOGIN", [334]);
  await exchange(
    secure,
    reader.read,
    Buffer.from(username).toString("base64"),
    [334],
  );
  await exchange(
    secure,
    reader.read,
    Buffer.from(password).toString("base64"),
    [235],
  );
  await exchange(secure, reader.read, `MAIL FROM:<${sender}>`, [250]);
  await exchange(secure, reader.read, `RCPT TO:<${recipient}>`, [250, 251]);
  await exchange(secure, reader.read, "DATA", [354]);

  const messageId = `<${randomUUID()}@dev.goodneighborsf.org>`;
  const body = [
    `From: Good Neighbor dev <${sender}>`,
    `To: <${recipient}>`,
    "Subject: [dev] Good Neighbor SMTP connectivity test",
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "This is a non-sensitive connectivity test from the Good Neighbor dev environment.",
    "No action is required.",
    ".",
  ].join("\r\n");
  await exchange(secure, reader.read, message, [250]);
  await exchange(secure, reader.read, "QUIT", [221]);
  reader.dispose();
  secure.end();
  console.info(JSON.stringify({ status: "accepted", messageId }));
} catch (error) {
  plain.destroy();
  console.error(error instanceof Error ? error.message : "SMTP probe failed");
  process.exitCode = 1;
}
