import { beforeEach, expect, it, vi } from "vitest";
const { send, randomInt } = vi.hoisted(() => ({
  send: vi.fn(),
  randomInt: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("node:crypto", async (original) => ({
  ...(await original()),
  randomInt,
}));
const { generateEnrollmentCode } = await import("./enrollment-codes.js");
beforeEach(() => {
  send.mockReset();
  randomInt.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "test-table");
  vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-secret");
});
it("uses standard uppercase letters/digits, preserves leading zeros, and avoids codes already used by either login flow", async () => {
  for (const index of [0, 10, 11, 1, 2, 3, 0, 35, 34, 4, 5, 6])
    randomInt.mockReturnValueOnce(index);
  send
    .mockResolvedValueOnce({ Item: {} })
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({})
    .mockResolvedValue({});
  expect(await generateEnrollmentCode()).toBe("0ZY456");
  expect(send).toHaveBeenCalledTimes(6);
});
it("bounds retries when codes collide", async () => {
  randomInt.mockReturnValue(0);
  send.mockResolvedValue({ Item: {} });
  await expect(generateEnrollmentCode()).rejects.toThrow("Unable to allocate");
  expect(randomInt).toHaveBeenCalledTimes(120);
});
