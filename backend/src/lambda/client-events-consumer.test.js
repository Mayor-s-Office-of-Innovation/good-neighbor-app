import { afterEach, describe, expect, it, vi } from "vitest";

const forward = vi.fn();
vi.mock("../handlers/event-forwarder.js", () => ({
  forwardClientEventGroups: forward,
}));

const { handler, CONSUMER_FORWARD_TIMEOUT_MS } = await import(
  "./client-events-consumer.js"
);

/**
 * Build a record whose body is the client envelope: the user agent rides in
 * the body's `ua`, never in a message attribute.
 * @param {string} messageId
 * @param {unknown} body
 * @param {string} [userAgent]
 * @returns {import("aws-lambda").SQSRecord}
 */
function record(messageId, body, userAgent = "TestUA/1.0") {
  const envelope =
    typeof body === "object" && body !== null && userAgent
      ? { ...body, ua: userAgent }
      : body;
  return /** @type {import("aws-lambda").SQSRecord} */ (
    /** @type {unknown} */ ({
      messageId,
      body: typeof envelope === "string" ? envelope : JSON.stringify(envelope),
      messageAttributes: {},
    })
  );
}

/**
 * @param {import("aws-lambda").SQSRecord[]} Records
 * @returns {Promise<import("aws-lambda").SQSBatchResponse>}
 */
async function call(Records) {
  return /** @type {Promise<import("aws-lambda").SQSBatchResponse>} */ (
    handler(
      /** @type {import("aws-lambda").SQSEvent} */ ({ Records }),
      /** @type {import("aws-lambda").Context} */ ({}),
      /** @type {import("aws-lambda").Callback} */ (() => {}),
    )
  );
}

const valid = {
  event: "camera_opened",
  id: "uuid-1",
  properties: { flow: "p" },
};

describe("client-events queue consumer", () => {
  afterEach(() => {
    forward.mockReset();
    vi.restoreAllMocks();
  });

  it("forwards every message's events in one call, each with its own user agent", async () => {
    forward.mockResolvedValue("forwarded");
    const res = await call([
      record(
        "m1",
        { batch: [valid, { ...valid, event: "photo_picked" }] },
        "Android/1",
      ),
      record("m2", valid, "iPhone/1"),
    ]);
    expect(res).toEqual({ batchItemFailures: [] });
    expect(forward).toHaveBeenCalledTimes(1);
    const [groups, deps] = forward.mock.calls[0];
    expect(groups).toHaveLength(2);
    expect(groups[0].messageId).toBe("m1");
    expect(
      groups[0].reports.map((/** @type {{event: string}} */ r) => r.event),
    ).toEqual(["camera_opened", "photo_picked"]);
    expect(groups[0].ctx).toEqual({ userAgent: "Android/1" });
    expect(groups[1].ctx).toEqual({ userAgent: "iPhone/1" });
    expect(deps.timeoutMs).toBe(CONSUMER_FORWARD_TIMEOUT_MS);
  });

  it("acknowledges garbage without forwarding and logs the drop per message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await call([
      record("m1", "{not json"),
      record("m2", { event: "nope", id: "u" }),
      record("m3", { batch: [] }),
    ]);
    expect(res).toEqual({ batchItemFailures: [] });
    expect(forward).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
    const line = JSON.parse(String(warn.mock.calls[1]?.[0]));
    expect(line.marker).toBe("ClientEventDropped");
    expect(line.source).toBe("queue");
  });

  it("reports only the messages that carried events when PostHog fails", async () => {
    forward.mockResolvedValue("failed");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await call([
      record("m1", valid),
      record("m2", { event: "nope", id: "u" }),
      record("m3", valid),
    ]);
    expect(res.batchItemFailures.map((f) => f.itemIdentifier)).toEqual([
      "m1",
      "m3",
    ]);
  });

  it("acknowledges in log-only mode and tolerates a missing user agent", async () => {
    forward.mockResolvedValue("log-only");
    const res = await call([record("m1", valid, "")]);
    expect(res).toEqual({ batchItemFailures: [] });
    expect(forward.mock.calls[0][0][0].ctx).toEqual({ userAgent: undefined });
  });

  it("logs and rethrows an unexpected error so the batch is redelivered", async () => {
    forward.mockRejectedValue(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(call([record("m1", valid)])).rejects.toThrow("boom");
    expect(JSON.parse(String(error.mock.calls[0]?.[0])).level).toBe("ERROR");
  });
});
