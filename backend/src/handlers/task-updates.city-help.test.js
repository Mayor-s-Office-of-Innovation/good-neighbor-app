import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  readTask: vi.fn(),
  readUpdatePointer: vi.fn(),
  writeTaskTransition: vi.fn(),
  prepare: vi.fn(),
  deliver: vi.fn(),
}));
vi.mock("../task-updates/task-update-store.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ...Object.fromEntries(
    Object.entries(mocks).filter(
      ([name]) => !["prepare", "deliver"].includes(name),
    ),
  ),
}));
vi.mock("../task-updates/city-help-note.js", async (importOriginal) => ({
  ...(await importOriginal()),
  prepareCityHelpNote: mocks.prepare,
  deliverCityHelpNote: mocks.deliver,
}));
import { createTaskUpdate } from "./task-updates.js";
const task = {
  taskId: "t1",
  status: "in_progress",
  updatedAt: "2026-10-09T11:00:00Z",
  appActionResults: [
    { code: "create_311_ticket", payload: { tickets: [{ srNum: "123" }] } },
  ],
};
/** @param {Record<string, unknown>} body */
const event = (body) => ({
  pathParameters: { taskId: "t1" },
  headers: { "idempotency-key": "attempt1" },
  requestContext: {
    authorizer: {
      jwt: { claims: { "custom:siteId": "site1", sub: "device1" } },
    },
  },
  body: JSON.stringify(body),
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DYNAMO_TABLE", "table");
  vi.stubEnv("S3_UPLOAD_BUCKET", "uploads");
  vi.stubEnv("SQS_QUEUE_URL", "queue");
  vi.stubEnv("GNP_311_SUBMISSION_ENABLED", "true");
  mocks.readTask.mockResolvedValue(task);
  mocks.readUpdatePointer.mockResolvedValue(null);
  mocks.writeTaskTransition.mockResolvedValue(undefined);
  mocks.prepare.mockResolvedValue({
    SRNum: "123",
    Notes: "Server-authored note",
  });
  mocks.deliver.mockResolvedValue(true);
});
it.each(["note_photo_update", "additional_action"])(
  "saves %s and sends the note only for No",
  async (type) => {
    const response = await createTaskUpdate(
      event({
        type,
        text: "Followed up",
        notes: ["Note"],
        photoKeys: [],
        cityHelpNeeded: false,
        siteName: "Untrusted",
        srNum: "different",
      }),
    );
    expect(response.statusCode).toBe(201);
    expect(mocks.prepare).toHaveBeenCalledWith(
      "table",
      "site1",
      "123",
      expect.any(String),
    );
    expect(mocks.writeTaskTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({ status: "in_progress" }),
        update: expect.objectContaining({
          cityHelpNeeded: false,
          cityNoteStatus: "pending",
        }),
      }),
    );
    expect(mocks.writeTaskTransition.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deliver.mock.invocationCallOrder[0],
    );
  },
);
it("Yes persists the choice without preparing a City request", async () => {
  const response = await createTaskUpdate(
    event({
      type: "additional_action",
      text: "Followed up",
      photoKeys: [],
      cityHelpNeeded: true,
    }),
  );
  expect(response.statusCode).toBe(201);
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(JSON.parse(response.body).update.cityHelpNeeded).toBe(true);
});

it.each(["issue_resolved", "presence_resolved", "additional_action_resolved"])(
  "%s persists the approved note before delivering each City ticket",
  async (type) => {
    mocks.readTask.mockResolvedValue({
      ...task,
      inProgressAt: new Date(Date.now() - 86400000 * 2).toISOString(),
      appActionResults: [
        {
          code: "create_311_ticket",
          payload: {
            executionTrigger: "user_confirmed",
            tickets: [
              { srNum: "123", responsibleAgency: "18" },
              { srNum: "456", responsibleAgency: "18" },
              { srNum: "123", responsibleAgency: "18" },
            ],
          },
        },
      ],
    });
    const response = await createTaskUpdate(
      event({
        type,
        text: "Private staff note",
        siteName: "Untrusted",
        srNum: "untrusted",
      }),
    );
    expect(response.statusCode, response.body).toBe(201);
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    for (const number of ["123", "456"])
      expect(mocks.prepare).toHaveBeenCalledWith(
        "table",
        "site1",
        number,
        expect.any(String),
        true,
      );
    const stored = mocks.writeTaskTransition.mock.calls[0][0];
    expect(stored.task.status).toBe("completed");
    expect(stored.update.cityNotes).toHaveLength(2);
    expect(
      stored.update.cityNotes.every(
        (/** @type {any} */ note) => note.cityNoteStatus === "pending",
      ),
    ).toBe(true);
    expect(mocks.writeTaskTransition.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deliver.mock.invocationCallOrder[0],
    );
  },
);

it("does not report resolution success before City confirmation and reuses its saved notes", async () => {
  mocks.deliver.mockResolvedValue(false);
  const body = { type: "issue_resolved" };
  expect((await createTaskUpdate(event(body))).statusCode).toBe(502);
  const stored = mocks.writeTaskTransition.mock.calls[0][0].update;
  expect(stored.cityNotes).toHaveLength(1);
  mocks.readUpdatePointer.mockResolvedValue(stored);
  mocks.deliver.mockResolvedValue(true);
  expect((await createTaskUpdate(event(body))).statusCode).toBe(200);
  expect(mocks.writeTaskTransition).toHaveBeenCalledTimes(1);
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
});

it("keeps resolution unsaved when City updates cannot be prepared or are disabled", async () => {
  mocks.prepare.mockRejectedValue(new Error("Site unavailable"));
  expect(
    (await createTaskUpdate(event({ type: "issue_resolved" }))).statusCode,
  ).toBe(503);
  expect(mocks.writeTaskTransition).not.toHaveBeenCalled();
  vi.stubEnv("GNP_311_SUBMISSION_ENABLED", "false");
  expect(
    (await createTaskUpdate(event({ type: "issue_resolved" }))).statusCode,
  ).toBe(503);
  expect(mocks.writeTaskTransition).not.toHaveBeenCalled();
});

it("excludes silent, simulated, and already-closed tickets from resolution notes", async () => {
  mocks.readTask.mockResolvedValue({
    ...task,
    appActionResults: [
      {
        code: "create_311_ticket",
        payload: {
          executionTrigger: "task_created",
          tickets: [{ srNum: "silent", responsibleAgency: "76" }],
        },
      },
      {
        code: "create_311_ticket",
        payload: {
          executionTrigger: "user_confirmed",
          tickets: [{ srNum: "SIM-example" }, { srNum: "closed" }],
        },
      },
      {
        code: "close_311_ticket",
        payload: { closures: [{ srNum: "closed", status: "closed" }] },
      },
    ],
  });
  expect(
    (await createTaskUpdate(event({ type: "issue_resolved" }))).statusCode,
  ).toBe(201);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it("requires a boolean choice for a 311 editor", async () => {
  for (const cityHelpNeeded of [undefined, null, "no"]) {
    expect(
      (
        await createTaskUpdate(
          event({
            type: "additional_action",
            text: "Note",
            photoKeys: [],
            cityHelpNeeded,
          }),
        )
      ).statusCode,
    ).toBe(400);
  }
  expect(mocks.writeTaskTransition).not.toHaveBeenCalled();
});
it("returns failure while delivery is unconfirmed, then reuses the saved event on retry", async () => {
  mocks.deliver.mockResolvedValue(false);
  const body = {
    type: "additional_action",
    text: "Note",
    photoKeys: [],
    cityHelpNeeded: false,
  };
  expect((await createTaskUpdate(event(body))).statusCode).toBe(502);
  const stored = mocks.writeTaskTransition.mock.calls[0][0].update;
  mocks.readUpdatePointer.mockResolvedValue(stored);
  mocks.deliver.mockResolvedValue(true);
  expect((await createTaskUpdate(event(body))).statusCode).toBe(200);
  expect(mocks.writeTaskTransition).toHaveBeenCalledTimes(1);
  expect(mocks.deliver).toHaveBeenLastCalledWith("table", "site1", stored);
});
it("does not persist No while 311 submission is disabled", async () => {
  vi.stubEnv("GNP_311_SUBMISSION_ENABLED", "false");
  expect(
    (
      await createTaskUpdate(
        event({
          type: "additional_action",
          text: "Note",
          photoKeys: [],
          cityHelpNeeded: false,
        }),
      )
    ).statusCode,
  ).toBe(503);
  expect(mocks.writeTaskTransition).not.toHaveBeenCalled();
});
it("rejects a City choice on a non-311 task", async () => {
  mocks.readTask.mockResolvedValue({ ...task, appActionResults: [] });
  expect(
    (
      await createTaskUpdate(
        event({
          type: "additional_action",
          text: "Note",
          photoKeys: [],
          cityHelpNeeded: false,
        }),
      )
    ).statusCode,
  ).toBe(400);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
