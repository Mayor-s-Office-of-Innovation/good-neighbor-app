import { beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
vi.mock("../../integrations/sf311-media.js", () => ({
  create311MediaLink: vi.fn(
    async () => "https://media.example/image?token=secret",
  ),
}));
import { attachImagesToServiceRequest } from "./app-actions.js";
import { create311MediaLink } from "../../integrations/sf311-media.js";
const url = "https://media.example/image?token=secret";
const artifact = { artifactId: "a", s3Key: "photo/a" };
function fixture() {
  /** @type {Array<Record<string, any>>} */
  let durable = [];
  const sf311 = {
    updateServiceRequest: vi.fn(async () => ({ updateId: "u1" })),
    getLatestUpdatesBySourceAgency: vi.fn(async () => ({})),
  };
  const opts = {
    sf311: /** @type {any} */ (sf311),
    config: /** @type {any} */ ({}),
    srNum: "123",
    artifacts: [artifact],
    nowDate: new Date(),
    onCheckpoint: vi.fn(async (attachments) => {
      durable = globalThis.structuredClone(attachments);
    }),
  };
  return { sf311, opts, durable: () => durable };
}
beforeEach(() => vi.clearAllMocks());
it("persists intent before sending and each accepted photo before the next", async () => {
  const f = fixture();
  f.opts.artifacts.push({ artifactId: "b", s3Key: "photo/b" });
  f.sf311.updateServiceRequest.mockImplementation(async () => {
    const state = f.durable();
    expect(state.at(-1)?.status).toBe("pending");
    if (state.length === 2) expect(state[0].status).toBe("submitted");
    expect(JSON.stringify(state)).not.toContain("secret");
    return { updateId: "u1" };
  });
  await attachImagesToServiceRequest(f.opts);
  expect(f.durable().map((a) => a.status)).toEqual(["submitted", "submitted"]);
});
it.each([true, false])(
  "reconciles an accepted upload lost before checkpoint (City evidence: %s)",
  async (found) => {
    const f = fixture();
    f.opts.onCheckpoint.mockImplementation(async (attachments) => {
      if (attachments[0].status === "submitted")
        throw new Error("checkpoint unavailable");
    });
    await expect(attachImagesToServiceRequest(f.opts)).rejects.toThrow(
      "checkpoint unavailable",
    );
    expect(f.sf311.updateServiceRequest).toHaveBeenCalledOnce();
    const pending = f.opts.onCheckpoint.mock.calls[0][0];
    expect(pending[0]).toMatchObject({
      status: "pending",
      urlHash: createHash("sha256").update(url).digest("hex"),
    });
    f.sf311.getLatestUpdatesBySourceAgency.mockResolvedValue(
      found
        ? { SRNum: "123", Updates: [{ UpdateType: "8", TextSubType: url }] }
        : {},
    );
    f.opts.onCheckpoint.mockResolvedValue(undefined);
    const result = await attachImagesToServiceRequest({
      ...f.opts,
      priorAttachments: pending,
    });
    expect(f.sf311.updateServiceRequest).toHaveBeenCalledOnce();
    expect(create311MediaLink).toHaveBeenCalledOnce();
    expect(result[0].status).toBe(found ? "submitted" : "pending");
    if (!found)
      expect(result[0].reason).toBe(
        "sf311_attachment_uncertain_requires_reconciliation",
      );
  },
);
it("does not send when the intent cannot be saved", async () => {
  const f = fixture();
  f.opts.onCheckpoint.mockRejectedValue(new Error("db unavailable"));
  await expect(attachImagesToServiceRequest(f.opts)).rejects.toThrow(
    "db unavailable",
  );
  expect(f.sf311.updateServiceRequest).not.toHaveBeenCalled();
});
it("retains uncertainty across a timeout and an unavailable City feed", async () => {
  const f = fixture();
  f.sf311.updateServiceRequest.mockRejectedValue(new Error("timeout"));
  const pending = await attachImagesToServiceRequest(f.opts);
  f.sf311.getLatestUpdatesBySourceAgency.mockRejectedValue(
    new Error("offline"),
  );
  const result = await attachImagesToServiceRequest({
    ...f.opts,
    priorAttachments: pending,
  });
  expect(result[0].status).toBe("pending");
  expect(f.sf311.updateServiceRequest).toHaveBeenCalledOnce();
});
