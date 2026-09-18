import { beforeEach, describe, expect, it, vi } from "vitest";

// The export module touches three AWS seams: the DocumentClient (watermark),
// the raw client (export control APIs), and time. Mock all three.
const { documentSend, rawSend, describeExport } = vi.hoisted(() => ({
  documentSend: vi.fn(),
  rawSend: vi.fn(),
  describeExport: vi.fn(),
}));

vi.mock("../db.js", () => ({ ddb: { send: documentSend } }));
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

/**
 * @param {Record<string, unknown> | undefined} watermarkItem
 */
function mockWatermark(watermarkItem) {
  documentSend.mockResolvedValue({ Item: watermarkItem });
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
    // Pending recorded; the completed cursor is NOT written (no exportToTime).
    const put = documentSend.mock.calls.find((c) => c[0].input.Item)?.[0];
    expect(put?.input.Item.pending).toEqual({
      from: null,
      to: 1789579800, // 2026-09-16T18:00:00Z − 30 min (mock clock is 2026)
      exportArn: "arn:aws:dynamodb:...:export/abc",
    });
    expect(put.input.Item.exportToTime).toBeUndefined();
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
    expect(
      startCmd.input.IncrementalExportSpecification.ExportFromTime,
    ).toEqual(new Date(1789569000 * 1000));
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
    const writes = documentSend.mock.calls.filter((c) => c[0].input.Item);
    expect(writes).toHaveLength(0);
    expect(
      rawSend.mock.calls.filter((c) => c[0].input.ExportType),
    ).toHaveLength(0);
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
