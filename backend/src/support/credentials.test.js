import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

/** @type {string | undefined} */
let directory;
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

it("signs support requests with the real profile provider despite emulator credentials", async () => {
  directory = await mkdtemp(join(tmpdir(), "gn-support-credentials-"));
  const credentialsFile = join(directory, "credentials");
  const configFile = join(directory, "config");
  await writeFile(
    credentialsFile,
    "[support-regression]\naws_access_key_id=PROFILE_TEST_KEY\naws_secret_access_key=PROFILE_TEST_SECRET\n",
    { mode: 0o600 },
  );
  await writeFile(configFile, "", { mode: 0o600 });
  vi.stubEnv("SUPPORT_AWS_PROFILE", "support-regression");
  vi.stubEnv("AWS_PROFILE", "unrelated-profile");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "localdev");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "localdevsecret");
  vi.stubEnv("AWS_SESSION_TOKEN", "");
  vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", credentialsFile);
  vi.stubEnv("AWS_CONFIG_FILE", configFile);
  vi.stubEnv("AWS_EC2_METADATA_DISABLED", "true");
  // The SDK warns about concurrent profile/environment sources. These are
  // intentional, fake fixtures; no actual credentials or AWS calls are used.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(Response.json({ output: "answer" }));
  vi.stubGlobal("fetch", fetcher);
  vi.resetModules();
  // Do not mock the credential provider: exercise the installed AWS SDK chain
  // and production SUPPORT_AWS_PROFILE selection through the actual signer.
  const { converse } = await import("./bedrock.js");
  await converse({
    region: "us-east-1",
    modelId: "amazon.nova-lite-v1:0",
    payload: {},
    signal: new globalThis.AbortController().signal,
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const [, request] of fetcher.mock.calls) {
    expect(request.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=PROFILE_TEST_KEY\//,
    );
    expect(request.headers.authorization).not.toContain("localdev");
  }
  expect(process.env.AWS_ACCESS_KEY_ID).toBe("localdev");
  expect(process.env.AWS_SECRET_ACCESS_KEY).toBe("localdevsecret");
  expect(process.env.AWS_PROFILE).toBe("unrelated-profile");
});
