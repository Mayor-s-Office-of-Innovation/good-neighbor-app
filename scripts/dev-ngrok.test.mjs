import { test } from "node:test";
import assert from "node:assert/strict";
import { ngrokOrigin, requireLocalStorage } from "./dev-ngrok.mjs";

const tunnel = (
  addr = "http://127.0.0.1:5173",
  public_url = "https://device.example.test",
) => ({ config: { addr }, public_url });
test("selects only the HTTPS tunnel for the local frontend", () => {
  assert.equal(
    ngrokOrigin([
      tunnel("http://localhost:3001", "https://other.example.test"),
      tunnel(),
      tunnel(undefined, "http://device.example.test"),
    ]),
    "https://device.example.test",
  );
  assert.equal(
    ngrokOrigin([tunnel("http://localhost:5173")]),
    "https://device.example.test",
  );
});
test("refuses absent, ambiguous, non-local, or malformed tunnel entries", () => {
  for (const entries of [
    [],
    [tunnel(), tunnel(undefined, "https://second.example.test")],
    [tunnel("http://remote.example.test:5173")],
    [tunnel(undefined, "https://user:password@device.example.test")],
    [tunnel(undefined, "https://device.example.test/path")],
    [{}],
  ]) {
    assert.throws(() => ngrokOrigin(entries));
  }
});
test("requires loopback MinIO instead of a deployed storage endpoint", () => {
  assert.doesNotThrow(() => requireLocalStorage("http://localhost:9000"));
  assert.doesNotThrow(() => requireLocalStorage("http://127.0.0.1:9000"));
  for (const endpoint of [
    undefined,
    "",
    "https://s3.example.test",
    "http://storage.example.test:9000",
    "http://user:password@localhost:9000",
  ])
    assert.throws(() => requireLocalStorage(endpoint));
});
