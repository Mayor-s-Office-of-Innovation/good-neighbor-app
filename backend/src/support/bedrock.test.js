import { afterEach, expect, it, vi } from "vitest";
vi.mock("@aws-sdk/credential-provider-node", () => ({
  defaultProvider: vi.fn(() => async () => ({
    accessKeyId: "TESTKEY",
    secretAccessKey: "test-secret",
    sessionToken: "test-session",
  })),
}));
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { converse } from "./bedrock.js";

const input = () => ({
  region: "us-west-2",
  modelId: "amazon.nova-lite-v1:0",
  payload: { question: "PRIVATE" },
  signal: new globalThis.AbortController().signal,
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("selects a support-only profile without changing emulator credentials", async () => {
  vi.stubEnv("SUPPORT_AWS_PROFILE", "test-support");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "localdev");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "localdevsecret");
  vi.resetModules();
  await import("./bedrock.js");
  expect(defaultProvider).toHaveBeenLastCalledWith({ profile: "test-support" });
  expect(process.env.AWS_ACCESS_KEY_ID).toBe("localdev");
  expect(process.env.AWS_SECRET_ACCESS_KEY).toBe("localdevsecret");
});

it("uses the normal execution-role chain without a support profile", async () => {
  vi.stubEnv("SUPPORT_AWS_PROFILE", "");
  vi.resetModules();
  await import("./bedrock.js");
  expect(defaultProvider).toHaveBeenLastCalledWith({});
});

it("signs the privacy check and inference, keeping question text off the settings call", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(Response.json({ output: "answer" }));
  vi.stubGlobal("fetch", fetcher);
  expect(await converse(input())).toEqual({ output: "answer" });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][0]).toBe(
    "https://bedrock.us-west-2.amazonaws.com/logging/modelinvocations",
  );
  expect(fetcher.mock.calls[0][1].body).toBeUndefined();
  const [url, request] = fetcher.mock.calls[1];
  expect(url).toBe(
    "https://bedrock-runtime.us-west-2.amazonaws.com/model/amazon.nova-lite-v1%3A0/converse",
  );
  expect(request.headers.authorization).toMatch(
    /^AWS4-HMAC-SHA256 Credential=TESTKEY\//,
  );
  expect(request.headers["x-amz-security-token"]).toBe("test-session");
  expect(request.body).toBe(JSON.stringify(input().payload));
});

it.each([
  { loggingConfig: { textDataDeliveryEnabled: true } },
  { loggingConfig: {} },
  null,
  [],
])("never sends user text when logging is unsafe: %j", async (config) => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(config));
  vi.stubGlobal("fetch", fetcher);
  await expect(converse(input())).rejects.toThrow("support_logging_enabled");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("fails closed when the logging configuration cannot be read", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response("private error", { status: 403 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(converse(input())).rejects.toThrow(
    "support_provider_unavailable",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
