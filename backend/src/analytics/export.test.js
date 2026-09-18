import { beforeEach, describe, expect, it, vi } from "vitest";

// The export module touches three AWS seams: the DocumentClient (watermark),
// the raw client (export control APIs), and time. Mock all three.
const { documentSend, rawSend, describeExport } = vi.hoisted(() => ({
  documentSend: vi.fn(),
  rawSend: vi.fn(),
  describeExport: vi.fn(),
}));

vi.mock("../db.js", () => ({ ddb: { send: documentSend } }));
vi.mock("../lib/log-server-error.js", () => ({ logServerError: vi.fn() }));
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {
    send = rawSend;
  },
  ExportTableToPointInTimeCommand: class {
    constructor(/** @type {any} */ input) {
      this.input = input;
    }
  },
  DescribeExportCommand: class {
    constructor(/** @type {any} */ input) {
      this.input = input;
    }
  },
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  GetCommand: class {
    constructor(/** @type {any} */ input) {
      this.input = input;
    }
  },
  PutCommand: class {
    constructor(/** @type {any} */ input) {
      this.input = input;
    }
  },
}));

const { handler } = await import("./export.js");
const { logServerError } = await import("../lib/log-server-error.js");

/**
 * @param {Record<string, unknown> | undefined} watermarkItem
 */
function mockWatermark(watermarkItem) {
  documentSend.mockResolvedValue({ Item: watermarkItem });
}

/**
 * Every PutCommand item written to the watermark, in order.
 * @returns {any[]}
 */
function watermarkWrites() {
  return documentSend.mock.calls
    .filter((c) => c[0].input.Item)
    .map((c) => c[0].input.Item);
}

/**
 * Every ExportTableToPointInTime input, in order.
 * @returns {any[]}
 */
function exportStarts() {
  return rawSend.mock.calls
    .filter((c) => c[0].input.ExportType)
    .map((c) => c[0].input);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DYNAMO_TABLE = "gnp-test-app";
  process.env.DYNAMO_TABLE_ARN =
    "arn:aws:dynamodb:us-west-2:111122223333:table/gnp-test-app";
  process.env.LAKE_BUCKET = "gnp-test-analytics-lake-x";
  rawSend.mockReset();
  describeExport.mockReset();
  vi.spyOn(Date, "now").mockReturnValue(
    new Date("2026-09-16T18:00:00.000Z").getTime(),
  );
});

describe("analytics export handler", () => {
  it("issues FULL_EXPORT on first run (no watermark item)", async () => {
    mockWatermark(undefined);
    rawSend.mockResolvedValue({
      ExportDescription: { ExportArn: "arn:aws:dynamodb:...:export/abc" },
    });

    await handler();

    const cmd = rawSend.mock.calls[0][0];
    expect(cmd.input.ExportType).toBe("FULL_EXPORT");
    expect(cmd.input.TableArn).toBe(process.env.DYNAMO_TABLE_ARN);
    expect(cmd.input.ClientToken).toBe("full-1789579800");
    // Pending recorded; the completed cursor is NOT written (no exportToTime).
    const [put] = watermarkWrites();
    expect(put.pending).toEqual({
      from: null,
      to: 1789579800, // 2026-09-16T18:00:00Z − 30 min (mock clock is 2026)
      exportArn: "arn:aws:dynamodb:...:export/abc",
    });
    expect(put.exportToTime).toBeUndefined();
  });

  it("goes incremental on the run after a completed FULL_EXPORT (cursor advances)", async () => {
    // Regression: the first-run full export must not repeat every 6h.
    mockWatermark({
      pending: { from: null, to: 1789572600, exportArn: "arn:...:export/full" },
    });
    rawSend
      .mockResolvedValueOnce({
        ExportDescription: { ExportStatus: "COMPLETED" },
      }) // DescribeExport
      .mockResolvedValueOnce({
        ExportDescription: { ExportArn: "arn:...:export/inc1" },
      }); // startExport

    await handler();

    const [start] = exportStarts();
    expect(start.ExportType).toBe("INCREMENTAL_EXPORT");
    expect(start.IncrementalExportSpecification.ExportFromTime).toEqual(
      new Date(1789572600 * 1000),
    );
    expect(start.ClientToken).toBe("1789572600-1789579800");

    // Two writes: the commit, then the start on top of the committed state.
    const [commit, started] = watermarkWrites();
    expect(commit.exportToTime).toBe(1789572600);
    expect(commit.lastExportId).toBe("arn:...:export/full");
    expect(commit.pending).toBeUndefined();
    expect(started.exportToTime).toBe(1789572600);
    expect(started.lastExportId).toBe("arn:...:export/full");
    expect(started.pending).toEqual({
      from: 1789572600,
      to: 1789579800,
      exportArn: "arn:...:export/inc1",
    });
  });

  it("requests an incremental export with NEW_IMAGE view when a watermark exists", async () => {
    mockWatermark({
      exportToTime: 1789569000,
      pending: { from: 1789569000, to: 1789576200, exportArn: "old" },
    });
    // pending reports completed → cursor advances, then a fresh window starts
    rawSend
      .mockResolvedValueOnce({
        ExportDescription: { ExportStatus: "COMPLETED" },
      }) // DescribeExport
      .mockResolvedValueOnce({
        ExportDescription: { ExportArn: "arn:...:export/next" },
      }); // startExport

    await handler();

    const startCmd = rawSend.mock.calls[1][0];
    expect(startCmd.input.ExportType).toBe("INCREMENTAL_EXPORT");
    expect(startCmd.input.TableArn).toBe(process.env.DYNAMO_TABLE_ARN);
    expect(startCmd.input.IncrementalExportSpecification.ExportViewType).toBe(
      "NEW_IMAGE",
    );
    // The new window starts at the just-committed pending endpoint, not the
    // pre-commit cursor.
    expect(
      startCmd.input.IncrementalExportSpecification.ExportFromTime,
    ).toEqual(new Date(1789576200 * 1000));
    expect(startCmd.input.ClientToken).toBe("1789576200-1789579800");

    const [, started] = watermarkWrites();
    expect(started.exportToTime).toBe(1789576200);
    expect(started.lastExportId).toBe("old");
    expect(started.pending.from).toBe(1789576200);
  });

  it("caps the incremental window at 24h when the cursor is more than a day behind", async () => {
    // DynamoDB rejects windows over 24h; a 3-day-old cursor must be caught up
    // one capped chunk per run, not sent as a single oversized window.
    const now = Math.floor(Date.now() / 1000);
    const from = now - 3 * 24 * 3600;
    const cappedTo = from + 24 * 3600 - 5 * 60;
    mockWatermark({ exportToTime: from });
    rawSend.mockResolvedValue({
      ExportDescription: { ExportArn: "arn:...:export/chunk1" },
    });

    await handler();

    const [start] = exportStarts();
    expect(start.ExportType).toBe("INCREMENTAL_EXPORT");
    expect(start.IncrementalExportSpecification.ExportFromTime).toEqual(
      new Date(from * 1000),
    );
    expect(start.IncrementalExportSpecification.ExportToTime).toEqual(
      new Date(cappedTo * 1000),
    );
    expect(start.ClientToken).toBe(`${from}-${cappedTo}`);
    const [started] = watermarkWrites();
    expect(started.pending.to).toBe(cappedTo);
  });

  it("falls back to FULL_EXPORT when the cursor is older than the PITR window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = now - 40 * 24 * 3600;
    mockWatermark({ exportToTime: stale, lastExportId: "arn:...:export/old" });
    rawSend.mockResolvedValue({
      ExportDescription: { ExportArn: "arn:...:export/refull" },
    });

    await handler();

    const [start] = exportStarts();
    expect(start.ExportType).toBe("FULL_EXPORT");
    expect(start.ClientToken).toBe("full-1789579800");
    expect(logServerError).toHaveBeenCalledTimes(1);

    // The stale cursor stays until the full export commits; pending.from is
    // null so the next run commits exportToTime = pending.to.
    const [started] = watermarkWrites();
    expect(started.exportToTime).toBe(stale);
    expect(started.pending).toEqual({
      from: null,
      to: 1789579800,
      exportArn: "arn:...:export/refull",
    });
  });

  it("does not advance the watermark when the pending export FAILED (window retried)", async () => {
    mockWatermark({
      exportToTime: 1789569000,
      pending: { from: 1789569000, to: 1789579800, exportArn: "arn-broken" },
    });
    rawSend.mockResolvedValueOnce({
      ExportDescription: {
        ExportStatus: "FAILED",
        FailureMessage: "AccessDenied",
      },
    });

    await expect(handler()).rejects.toThrow(/FAILED/);
    // No advance write and no new export start happened.
    expect(watermarkWrites()).toHaveLength(0);
    expect(exportStarts()).toHaveLength(0);
  });

  it("waits (no new export) while the pending export is still IN_PROGRESS", async () => {
    mockWatermark({
      pending: { from: 1, to: 2, exportArn: "arn-running" },
    });
    rawSend.mockResolvedValueOnce({
      ExportDescription: { ExportStatus: "IN_PROGRESS" },
    });

    await handler();

    expect(
      rawSend.mock.calls.filter((c) => c[0].input.ExportType),
    ).toHaveLength(0);
  });

  it("skips when there is no new window to export", async () => {
    // to = now - 30 min; watermark at exactly `to` means nothing new.
    const to = Math.floor(Date.now() / 1000) - 30 * 60;
    mockWatermark({ exportToTime: to });
    await handler();
    expect(
      rawSend.mock.calls.filter((c) => c[0].input.ExportType),
    ).toHaveLength(0);
  });

  it("throws without DYNAMO_TABLE_ARN (the TableArn fix)", async () => {
    delete process.env.DYNAMO_TABLE_ARN;
    await expect(handler()).rejects.toThrow(/DYNAMO_TABLE_ARN/);
  });
});
