import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  readTask: vi.fn(),
  update: vi.fn(),
  latest: vi.fn(),
}));
vi.mock("../db.js", () => ({
  ddb: {
    send: (/** @type {any} */ command) =>
      command instanceof GetCommand &&
      command.input.Key?.sk?.startsWith("TASK#")
        ? mocks.readTask(command)
        : mocks.send(command),
  },
}));
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
  mocks.readTask.mockReset().mockResolvedValue({ Item: { appActions: [] } });
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
      integration: "sf311",
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

it("targets an open ticket after a partial closure and none after all close", () => {
  const task = {
    appActionResults: [
      {
        code: "create_311_ticket",
        payload: { tickets: [{ srNum: "123" }, { srNum: "456" }] },
      },
      {
        code: "close_311_ticket",
        payload: { closures: [{ srNum: "123", status: "closed" }] },
      },
    ],
  };
  expect(cityHelpTicket(task)).toBe("456");
  task.appActionResults.push({
    code: "close_311_ticket",
    payload: { closures: [{ srNum: "456", status: "closed" }] },
  });
  expect(cityHelpTicket(task)).toBe("");
});

it("never sends or reconciles a synthetic reference, even on a legacy delivery record", async () => {
  expect(
    await deliverCityHelpNote("table", "site", {
      ...update(),
      cityNotePayload: { ...payload, SRnum: "SIM-synthetic" },
    }),
  ).toBe(true);
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.latest).not.toHaveBeenCalled();
});

it("does not send a note for a silent ticket while globally disabled", async () => {
  mocks.readTask.mockResolvedValue({
    Item: {
      createdAt: "2026-10-29T12:00:00Z",
      appActions: [
        {
          code: "create_311_ticket",
          payload: { executionTrigger: "task_created" },
        },
      ],
    },
  });
  mocks.send.mockResolvedValue({ Item: { enabled: false } });
  expect(await deliverCityHelpNote("table", "site", update())).toBe(true);
  expect(mocks.latest).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
});

it("still sends notes for a manual ticket on a task with an older silent workflow", async () => {
  mocks.readTask.mockResolvedValue({
    Item: {
      appActions: [
        {
          code: "create_311_ticket",
          payload: { executionTrigger: "task_created" },
        },
      ],
      appActionResults: [
        {
          code: "create_311_ticket",
          payload: {
            executionTrigger: "user_confirmed",
            tickets: [{ srNum: "123" }],
          },
        },
      ],
    },
  });
  mocks.send.mockResolvedValue({ Item: { enabled: false } });
  expect(await deliverCityHelpNote("table", "site", update())).toBe(true);
  expect(mocks.update).toHaveBeenCalledWith(payload);
  expect(
    mocks.send.mock.calls.some(
      ([command]) =>
        command instanceof GetCommand &&
        command.input.Key?.pk === "SYSTEM#CONTROLS",
    ),
  ).toBe(false);
});

function silentTask() {
  mocks.readTask.mockResolvedValue({
    Item: {
      createdAt: "2026-10-29T12:00:00Z",
      appActions: [
        {
          code: "create_311_ticket",
          payload: { executionTrigger: "task_created" },
        },
      ],
    },
  });
}

it("durably suppresses pending silent notes and completes subsequent calls without reads", async () => {
  silentTask();
  mocks.send.mockResolvedValue({ Item: { enabled: false } });
  const event = update();
  expect(await deliverCityHelpNote("table", "site", event)).toBe(true);
  expect(event.cityNoteStatus).toBe("suppressed");
  const write = mocks.send.mock.calls.filter(
    ([command]) => command instanceof UpdateCommand,
  )[0][0].input;
  expect(write.ConditionExpression).toBe(
    "cityNoteStatus = :prior AND attribute_not_exists(cityNoteLeaseExpiresAt)",
  );
  expect(write.ExpressionAttributeValues).toEqual({
    ":suppressed": "suppressed",
    ":prior": "pending",
  });
  mocks.send.mockClear();
  mocks.readTask.mockClear();
  expect(await deliverCityHelpNote("table", "site", event)).toBe(true);
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.readTask).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
});

it("does not overwrite another active delivery or a concurrent state change", async () => {
  silentTask();
  mocks.send.mockResolvedValue({ Item: { enabled: false } });
  expect(
    await deliverCityHelpNote("table", "site", {
      ...update(),
      cityNoteStatus: "sending",
      cityNoteLeaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
  ).toBe(false);
  expect(
    mocks.send.mock.calls.some(([command]) => command instanceof UpdateCommand),
  ).toBe(false);
  mocks.send.mockImplementation(async (command) => {
    if (command instanceof UpdateCommand)
      throw Object.assign(new Error("race"), {
        name: "ConditionalCheckFailedException",
      });
    return { Item: { enabled: false } };
  });
  const event = update();
  expect(await deliverCityHelpNote("table", "site", event)).toBe(false);
  expect(event.cityNoteStatus).toBe("pending");
  expect(mocks.update).not.toHaveBeenCalled();
});

it("suppresses an expired attempt without reconciling or claiming it was sent", async () => {
  silentTask();
  mocks.send.mockResolvedValue({ Item: { enabled: false } });
  const event = {
    ...update(),
    cityNoteStatus: "unknown",
    cityNoteLeaseExpiresAt: "2020-01-01T00:00:00.000Z",
  };
  expect(await deliverCityHelpNote("table", "site", event)).toBe(true);
  expect(event.cityNoteStatus).toBe("suppressed");
  expect(event.cityNoteLeaseExpiresAt).toBeUndefined();
  const write = mocks.send.mock.calls.filter(
    ([command]) => command instanceof UpdateCommand,
  )[0][0].input;
  expect(write.ConditionExpression).toContain(
    "cityNoteLeaseExpiresAt = :lease AND cityNoteLeaseExpiresAt <= :now",
  );
  expect(mocks.latest).not.toHaveBeenCalled();
});

it("checkpoints suppression after claiming with the owned lease", async () => {
  silentTask();
  const { Silent311Suppressed } = await import("../domain/silent-311.js");
  mocks.update.mockRejectedValue(new Silent311Suppressed());
  const event = update();
  expect(await deliverCityHelpNote("table", "site", event)).toBe(true);
  expect(event.cityNoteStatus).toBe("suppressed");
  const writes = mocks.send.mock.calls
    .filter(([command]) => command instanceof UpdateCommand)
    .map(([command]) => command.input);
  expect(writes).toHaveLength(2);
  expect(writes[1].ExpressionAttributeValues[":status"]).toBe("suppressed");
  expect(writes[1].ExpressionAttributeValues[":lease"]).toBe(
    writes[0].ExpressionAttributeValues[":lease"],
  );
  expect(writes[1].ConditionExpression).toBe(
    "cityNoteStatus = :sending AND cityNoteLeaseExpiresAt = :lease",
  );
});
