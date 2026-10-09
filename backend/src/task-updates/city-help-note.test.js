import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  update: vi.fn(),
  latest: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send: mocks.send } }));
vi.mock("../integrations/sf311-client.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createSf311Client: () => ({
    updateServiceRequest: mocks.update,
    getLatestUpdatesBySourceAgency: mocks.latest,
  }),
}));
import {
  buildNoteUpdatePayload,
  Sf311Error,
} from "../integrations/sf311-client.js";
import {
  cityHelpTicket,
  prepareCityHelpNote,
  deliverCityHelpNote,
  cityHelpNoteExists,
} from "./city-help-note.js";

const payload = buildNoteUpdatePayload({
  srNum: "123",
  siteName: "St. John's",
  now: new Date("2026-10-09T12:00:00Z"),
});
const update = () => ({
  taskId: "t1",
  updateId: "u1",
  occurredAt: "2026-10-09T12:00:00Z",
  cityNotePayload: payload,
  cityNoteStatus: "pending",
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockReset().mockResolvedValue({});
  mocks.update.mockReset().mockResolvedValue({ updateId: "city1" });
  mocks.latest.mockReset();
  vi.stubEnv("GNP_311_SUBMISSION_ENABLED", "true");
  vi.stubEnv("DYNAMO_TABLE", "table");
  vi.stubEnv("S3_UPLOAD_BUCKET", "uploads");
  vi.stubEnv("SQS_QUEUE_URL", "queue");
  vi.stubEnv("SF311_UPDATESR_URL", "https://hub.test/updatesr");
  vi.stubEnv("SF311_BASIC_AUTH_USER", "test");
  vi.stubEnv("SF311_BASIC_AUTH_PASS", "test");
});

describe("311 City help note", () => {
  it("uses the documented Add Notes contract and exact provider-site message", () => {
    expect(payload).toEqual({
      SRnum: "123",
      UpdateType: "5",
      SendingAgency: "76",
      SourceOperator: "Good Neighbor App",
      NumericSubType: "2",
      TextSubType: "",
      EffectiveDate: "2026-10-09 12:00:00",
      ToAgencyDate: "",
      Notes: `The provider site "St. John's" reports that the issue is resolved or City help is no longer needed.`,
    });
  });
  it("selects the first filed ticket and obtains the site name from its tenant", async () => {
    expect(
      cityHelpTicket({
        appActionResults: [
          {
            code: "create_311_ticket",
            payload: { tickets: [{ srNum: "123" }, { srNum: "456" }] },
          },
        ],
      }),
    ).toBe("123");
    mocks.send.mockResolvedValue({ Item: { name: "St. John's" } });
    expect(
      await prepareCityHelpNote(
        "table",
        "site1",
        "123",
        "2026-10-09T12:00:00Z",
      ),
    ).toEqual(payload);
    expect(mocks.send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(mocks.send.mock.calls[0][0].input.Key).toEqual({
      pk: "SITE#site1",
      sk: "#META",
    });
  });
  it("claims delivery before sending and checkpoints success", async () => {
    const event = update();
    expect(await deliverCityHelpNote("table", "site1", event)).toBe(true);
    expect(mocks.send.mock.calls[0][0]).toBeInstanceOf(UpdateCommand);
    expect(
      mocks.send.mock.calls[0][0].input.ExpressionAttributeValues[":prior"],
    ).toBe("pending");
    expect(mocks.update).toHaveBeenCalledWith(payload);
    expect(
      mocks.send.mock.calls[1][0].input.ExpressionAttributeValues[":status"],
    ).toBe("sent");
    expect(event.cityNoteStatus).toBe("sent");
    await deliverCityHelpNote("table", "site1", event);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
  it("does not send when another request owns delivery", async () => {
    mocks.send.mockRejectedValue(new Error("conditional conflict"));
    expect(await deliverCityHelpNote("table", "site1", update())).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("respects an active lease and the integration switch", async () => {
    const event = {
      ...update(),
      cityNoteStatus: "sending",
      cityNoteLeaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    expect(await deliverCityHelpNote("table", "site1", event)).toBe(false);
    vi.stubEnv("GNP_311_SUBMISSION_ENABLED", "false");
    expect(await deliverCityHelpNote("table", "site1", update())).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("leaves explicit HUB rejections retryable without declaring success", async () => {
    mocks.update.mockRejectedValue(new Sf311Error("rejected", { code: "26" }));
    const event = update();
    expect(await deliverCityHelpNote("table", "site1", event)).toBe(false);
    expect(event.cityNoteStatus).toBe("pending");
  });
  it("reconciles uncertain sends without repeating the outbound note", async () => {
    const event = update();
    mocks.update.mockRejectedValue(new Error("connection lost"));
    expect(await deliverCityHelpNote("table", "site1", event)).toBe(false);
    expect(event.cityNoteStatus).toBe("unknown");
    mocks.latest.mockResolvedValue({
      data: { service_requests: [{ SRNum: "123", Updates: [payload] }] },
    });
    expect(await deliverCityHelpNote("table", "site1", event)).toBe(true);
    expect(event.cityNoteStatus).toBe("sent");
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
  it("does not mistake a note on another ticket or at another time for this note", () => {
    expect(
      cityHelpNoteExists(
        { SRNum: "456", Updates: [{ ...payload, SRnum: "456" }] },
        payload,
      ),
    ).toBe(false);
    expect(
      cityHelpNoteExists(
        {
          SRNum: "123",
          Updates: [{ ...payload, EffectiveDate: "2026-10-08 12:00:00" }],
        },
        payload,
      ),
    ).toBe(false);
  });
  it("does not resend an expired attempt when the City feed cannot confirm it", async () => {
    mocks.latest.mockResolvedValue({ data: [] });
    const event = {
      ...update(),
      cityNoteStatus: "sending",
      cityNoteLeaseExpiresAt: "2020-01-01T00:00:00Z",
    };
    expect(await deliverCityHelpNote("table", "site1", event)).toBe(false);
    expect(event.cityNoteStatus).toBe("unknown");
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

it("keeps an unconfigured attempt pending without claiming or sending", async () => {
  vi.stubEnv("SF311_UPDATESR_URL", "");
  const event = update();
  expect(await deliverCityHelpNote("table", "site1", event)).toBe(false);
  expect(event.cityNoteStatus).toBe("pending");
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
});

it("does not mark an empty City response as a confirmed delivery", async () => {
  mocks.update.mockResolvedValue({ updateId: null });
  const event = update();
  expect(await deliverCityHelpNote("table", "site1", event)).toBe(false);
  expect(event.cityNoteStatus).toBe("unknown");
});

it("logs safe outbound diagnostics without HUB payloads or exception messages", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    mocks.update.mockRejectedValue(
      new Sf311Error("SECRET note credentials", {
        code: "26",
        request: { Notes: "PRIVATE" },
        body: "PRIVATE",
      }),
    );
    await expect(deliverCityHelpNote("table", "site", update())).resolves.toBe(
      false,
    );
    const entry = JSON.parse(log.mock.calls[0][0]);
    expect(entry).toMatchObject({
      route: "city-note",
      stage: "outbound",
      taskId: "t1",
      updateId: "u1",
      code: "26",
    });
    expect(entry.stack).toContain("at ");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /SECRET|PRIVATE|credentials/,
    );
  } finally {
    log.mockRestore();
  }
});

it("does not log expected competing delivery claims as errors", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    mocks.send.mockRejectedValue(
      Object.assign(new Error("claim lost"), {
        name: "ConditionalCheckFailedException",
      }),
    );
    await expect(deliverCityHelpNote("table", "site", update())).resolves.toBe(
      false,
    );
    expect(log).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

it.each(["configuration", "claim", "reconciliation", "checkpoint"])(
  "reports the %s failure stage",
  async (stage) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const item = update();
      if (stage === "configuration") vi.stubEnv("SF311_UPDATESR_URL", "");
      if (stage === "claim")
        mocks.send.mockRejectedValueOnce(new Error("database failed"));
      if (stage === "reconciliation") {
        item.cityNoteStatus = "unknown";
        mocks.latest.mockRejectedValueOnce(new Error("feed failed"));
      }
      if (stage === "checkpoint")
        mocks.send
          .mockResolvedValueOnce({})
          .mockRejectedValueOnce(new Error("checkpoint failed"));
      await expect(deliverCityHelpNote("table", "site", item)).resolves.toBe(
        false,
      );
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ stage });
    } finally {
      log.mockRestore();
    }
  },
);
