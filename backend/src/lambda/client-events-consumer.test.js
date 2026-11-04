import { afterEach, describe, expect, it, vi } from "vitest";

const forward = vi.fn();
vi.mock("../handlers/event-forwarder.js", () => ({
  forwardClientEventGroups: forward,
}));
const forwardErrors = vi.fn();
vi.mock("../handlers/forwarder.js", () => ({
  forwardClientErrors: forwardErrors,
}));

const {
  handler,
  CONSUMER_FORWARD_TIMEOUT_MS,
  KIND_ATTRIBUTE,
  KIND_CLIENT_ERROR,
} = await import("./client-events-consumer.js");

/**
 * An error-kind record: same envelope idea (`ua` in the body), tagged by the
 * gateway's static Kind attribute.
 * @param {string} messageId
 * @param {unknown} body
 * @param {string} [userAgent]
 * @returns {import("aws-lambda").SQSRecord}
 */
function errorRecord(messageId, body, userAgent = "TestUA/1.0") {
  const base = record(messageId, body, userAgent);
  return /** @type {import("aws-lambda").SQSRecord} */ (
    /** @type {unknown} */ ({
      ...base,
      messageAttributes: {
        [KIND_ATTRIBUTE]: {
          dataType: "String",
          stringValue: KIND_CLIENT_ERROR,
        },
      },
    })
  );
}

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

const validError = { type: "Error", message: "boom", id: "uuid-1" };

describe("client-events queue consumer", () => {
  afterEach(() => {
    forward.mockReset();
    forwardErrors.mockReset();
    vi.restoreAllMocks();
  });

  it("forwards error-kind messages through the error forwarder in one call", async () => {
    forward.mockResolvedValue("forwarded");
    forwardErrors.mockResolvedValue("forwarded");
    const res = await call([
      errorRecord("e1", validError, "Android/1"),
      record("m1", valid, "iPhone/1"),
      errorRecord("e2", { ...validError, message: "again" }, "iPhone/2"),
    ]);
    expect(res).toEqual({ batchItemFailures: [] });
    expect(forwardErrors).toHaveBeenCalledTimes(1);
    const [entries, deps] = forwardErrors.mock.calls[0];
    expect(
      entries.map((/** @type {{messageId: string}} */ e) => e.messageId),
    ).toEqual(["e1", "e2"]);
    expect(entries[0].report.message).toBe("boom");
    expect(entries[0].ctx).toEqual({ userAgent: "Android/1" });
    expect(entries[1].ctx).toEqual({ userAgent: "iPhone/2" });
    expect(deps.timeoutMs).toBe(CONSUMER_FORWARD_TIMEOUT_MS);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward.mock.calls[0][0]).toHaveLength(1);
  });

  it("fails only the kind whose forward failed", async () => {
    forward.mockResolvedValue("forwarded");
    forwardErrors.mockResolvedValue("failed");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await call([
      errorRecord("e1", validError),
      record("m1", valid),
      errorRecord("e2", "{not json"),
    ]);
    expect(res.batchItemFailures.map((f) => f.itemIdentifier)).toEqual(["e1"]);
  });

  it("drops an invalid error report with the error marker and acknowledges it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await call([
      errorRecord("e1", { type: "Nope", message: "x", id: "u" }),
    ]);
    expect(res).toEqual({ batchItemFailures: [] });
    expect(forwardErrors).not.toHaveBeenCalled();
    const line = JSON.parse(String(warn.mock.calls[0]?.[0]));
    expect(line.marker).toBe("ClientErrorDropped");
    expect(line.source).toBe("queue");
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
    // Stable ids: message id plus position, so a redelivery repeats them.
    const uuids = groups.flatMap(
      (/** @type {{ reports: { uuid?: string }[] }} */ g) =>
        g.reports.map((/** @type {{ uuid?: string }} */ r) => r.uuid),
    );
    expect(new Set(uuids).size).toBe(uuids.length);
    for (const uuid of uuids) expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
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
