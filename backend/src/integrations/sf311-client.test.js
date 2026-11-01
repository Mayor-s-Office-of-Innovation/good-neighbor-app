import { describe, expect, it, vi } from "vitest";
import {
  buildAttachmentUpdatePayload,
  buildCloseSrPayload,
  buildCreateSrPayload,
  createSf311Client,
  findResponsibleAgencyInLookup,
  hubDateTime,
  Sf311Error,
  SF311_TIMEOUTS,
  sourceRequestId,
} from "./sf311-client.js";

describe("SF311 CreateSR client helpers", () => {
  it("formats HUB datetimes with spaces and without milliseconds or timezone suffix", () => {
    expect(hubDateTime(new Date("2026-09-02T17:11:12.345Z"))).toBe(
      "2026-09-02 17:11:12",
    );
  });

  it("builds a CreateSR payload with documented field names", () => {
    expect(
      buildCreateSrPayload({
        taskId: "task-123",
        serviceCode: "1.1.4.7.20.0",
        responsibleAgency: "5",
        problemDescription: "Trash near the doorway",
        location: {
          latitude: 37.76656393517443,
          longitude: -122.4213267021692,
        },
        now: new Date("2026-09-02T17:11:12.000Z"),
      }),
    ).toEqual({
      SourceAgency: "76",
      SourceRequestID: "task-123-1147200",
      SourceOperator: "Good Neighbor App",
      ResponsibleAgency: "5",
      ResponsibleAgencyRequestID: "",
      SourceAgencyReceiveDate: "2026-09-02 17:11:12",
      TransferToResponsiblAgencyDate: "",
      PublicVisibilityIndicator: "0",
      CustomerName: "",
      CustomerPhone: "",
      CustomerAddress1: "",
      CustomerAddress2: "",
      CustomerCity: "",
      CustomerState: "",
      CustomerZip: "",
      CustomerCountry: "",
      CustomerEmail: "",
      CallbackRequestedIndicator: "0",
      CallbackNotes: "",
      NatureofRequest: "1.1.4.7.20.0",
      ProblemDescription: "Trash near the doorway",
      PriorityType: "",
      EmergencyType: "",
      Status: "",
      LinkID: "",
      LocationPointofInterest: "",
      LocationStreetNumber: "",
      LocationStreetName: "",
      LocationCrossStreet1: "",
      LocationCrossStreet2: "",
      LocationDescription: "",
      EasID: "",
      BlockLot: "",
      CNN: "",
      DeptAssetType: "",
      DeptAssetID: "",
      Xcoordinate: "",
      Ycoordinate: "",
      Latitude: "37.76656393517443",
      Longitude: "-122.4213267021692",
    });
  });

  it("builds an UpdateSR attachment payload with HUB field names", () => {
    expect(
      buildAttachmentUpdatePayload({
        srNum: "2000008106",
        imageUrl: "https://uploads.example.test/photo.jpg",
        now: new Date("2026-09-02T17:11:12.000Z"),
      }),
    ).toEqual({
      SRnum: "2000008106",
      UpdateType: "8",
      SendingAgency: "76",
      SourceOperator: "Good Neighbor App",
      NumericSubType: "1",
      TextSubType: "https://uploads.example.test/photo.jpg",
      EffectiveDate: "2026-09-02 17:11:12",
      ToAgencyDate: "",
      Notes: "",
    });
  });

  it("keeps SourceRequestID within HUB's 50-character limit", () => {
    expect(
      sourceRequestId({
        taskId: "task-with-a-very-long-generated-id-that-keeps-going",
        serviceCode: "1.1.4.7.20.0",
      }),
    ).toHaveLength(50);
  });

  it("builds an UpdateSR close payload with HUB field names", () => {
    expect(
      buildCloseSrPayload({
        srNum: "2000008106",
        now: new Date("2026-09-02T17:11:12.000Z"),
      }),
    ).toEqual({
      SRnum: "2000008106",
      UpdateType: "11",
      SendingAgency: "76",
      SourceOperator: "Good Neighbor App",
      NumericSubType: "1",
      TextSubType: "",
      EffectiveDate: "2026-09-02 17:11:12",
      ToAgencyDate: "",
      Notes: "",
    });
  });

  it("finds ResponsibleAgency in nested lookup responses", () => {
    expect(
      findResponsibleAgencyInLookup(
        { data: [{ NatureofRequest: "1.1.4.7.20.0", ResponsibleAgency: 5 }] },
        "1.1.4.7.20.0",
      ),
    ).toBe("5");
  });

  it("rejects successful CreateSR responses that do not include an SRNum", async () => {
    const payload = buildCreateSrPayload({
      taskId: "task-123",
      serviceCode: "1.1.4.7.20.0",
      responsibleAgency: "76",
      problemDescription: "Trash near the doorway",
      location: {
        latitude: 37.76656393517443,
        longitude: -122.4213267021692,
      },
      now: new Date("2026-09-02T17:11:12.000Z"),
    });
    const fetchImpl = async () =>
      new Response(JSON.stringify({ data: { return_code: "0" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const client = createSf311Client({
      config: {
        uploadBucket: "bucket",
        queueUrl: "queue",
        dynamoTable: "table",
        sf311CreateSrUrl: "https://hub.example.test/createsr",
        sf311AgencyLookupUrl: "https://hub.example.test/lookup",
        sf311BasicAuthUser: "user",
        sf311BasicAuthPass: "pass",
      },
      fetchImpl,
    });

    await expect(client.createServiceRequest(payload)).rejects.toMatchObject({
      name: "Sf311Error",
      code: "missing_srnum",
      status: 200,
      request: payload,
    });
    await expect(client.createServiceRequest(payload)).rejects.toBeInstanceOf(
      Sf311Error,
    );
  });

  it("converts SF311 request timeouts into retryable Sf311Errors", async () => {
    const timeout = new Error("Timed out");
    timeout.name = "TimeoutError";
    const fetchImpl = vi.fn().mockRejectedValue(timeout);
    const client = createSf311Client({
      config: {
        uploadBucket: "bucket",
        queueUrl: "queue",
        dynamoTable: "table",
        sf311CreateSrUrl: "https://hub.example.test/createsr",
        sf311UpdateSrUrl: "https://hub.example.test/updatesr",
        sf311AgencyLookupUrl: "https://hub.example.test/lookup",
        sf311BasicAuthUser: "user",
        sf311BasicAuthPass: "pass",
      },
      fetchImpl,
    });
    const payload = { SourceRequestID: "task-123" };

    await expect(
      client.lookupResponsibleAgency("1.1.4.7.20.0"),
    ).rejects.toMatchObject({
      name: "Sf311Error",
      code: "sf311_timeout",
      request: { serviceCode: "1.1.4.7.20.0" },
    });
    await expect(client.createServiceRequest(payload)).rejects.toMatchObject({
      name: "Sf311Error",
      code: "sf311_timeout",
      request: payload,
    });
    await expect(client.updateServiceRequest(payload)).rejects.toMatchObject({
      name: "Sf311Error",
      code: "sf311_timeout",
      request: payload,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0][1].signal).toBeTruthy();
  });

  describe("per-operation timeouts", () => {
    const config = {
      uploadBucket: "bucket",
      queueUrl: "queue",
      dynamoTable: "table",
      sf311CreateSrUrl: "https://hub.example.test/createsr",
      sf311UpdateSrUrl: "https://hub.example.test/updatesr",
      sf311AgencyLookupUrl: "https://hub.example.test/lookup",
      sf311LatestUpdatesUrl: "https://hub.example.test/latest/{agencyID}",
      sf311BasicAuthUser: "user",
      sf311BasicAuthPass: "pass",
    };
    /**
     * A HUB that never answers; the request ends only when our timer aborts it.
     * @returns {typeof fetch}
     */
    const hangingFetch = () =>
      /** @type {typeof fetch} */ (
        /** @type {unknown} */ (
          vi.fn(
            (
              /** @type {string} */ _url,
              /** @type {{ signal?: { addEventListener: (type: string, listener: () => void) => void } }} */ init,
            ) =>
              new Promise((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => {
                  const error = new Error("aborted");
                  error.name = "AbortError";
                  reject(error);
                });
              }),
          )
        )
      );
    /**
     * @param {Promise<unknown>} promise
     * @returns {() => string} the promise's state when called
     */
    const settled = (promise) => {
      let state = "pending";
      promise.then(
        () => (state = "resolved"),
        () => (state = "rejected"),
      );
      return () => state;
    };

    it("gives reads 10 s and writes 60 s", async () => {
      vi.useFakeTimers();
      try {
        const client = createSf311Client({ config, fetchImpl: hangingFetch() });
        const read = client.getLatestUpdatesBySourceAgency();
        const lookup = client.lookupResponsibleAgency("1.1.4.7.20.0");
        const create = client.createServiceRequest({ SourceRequestID: "t" });
        const update = client.updateServiceRequest({ SRnum: "1" });
        const states = [read, lookup, create, update].map(settled);
        for (const promise of [read, lookup, create, update])
          promise.catch(() => {});

        await vi.advanceTimersByTimeAsync(SF311_TIMEOUTS.read + 1);
        expect(states.map((state) => state())).toEqual([
          "rejected",
          "rejected",
          "pending",
          "pending",
        ]);
        await expect(read).rejects.toMatchObject({ code: "sf311_timeout" });

        await vi.advanceTimersByTimeAsync(
          SF311_TIMEOUTS.write - SF311_TIMEOUTS.read,
        );
        expect(states.map((state) => state())).toEqual([
          "rejected",
          "rejected",
          "rejected",
          "rejected",
        ]);
        await expect(create).rejects.toMatchObject({ code: "sf311_timeout" });
        await expect(update).rejects.toMatchObject({ code: "sf311_timeout" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("lets a caller shorten the write budget", async () => {
      vi.useFakeTimers();
      try {
        const client = createSf311Client({
          config,
          fetchImpl: hangingFetch(),
          timeouts: { write: 15_000 },
        });
        const update = client.updateServiceRequest({ SRnum: "1" });
        const state = settled(update);
        update.catch(() => {});
        await vi.advanceTimersByTimeAsync(14_999);
        expect(state()).toBe("pending");
        await vi.advanceTimersByTimeAsync(2);
        expect(state()).toBe("rejected");
        await expect(update).rejects.toMatchObject({ code: "sf311_timeout" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears the timer once the HUB answers", async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = vi.fn(
          async () =>
            new Response(JSON.stringify({ data: [] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        );
        const client = createSf311Client({ config, fetchImpl });
        await client.getLatestUpdatesBySourceAgency();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

it("validates endpoints per operation so UpdateSR works without creation settings", async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ data: { return_code: "0", UpdateID: "u1" } }),
      ),
    );
  const client = createSf311Client({
    config: {
      uploadBucket: "bucket",
      queueUrl: "queue",
      dynamoTable: "table",
      sf311UpdateSrUrl: "https://hub.test/update",
      sf311BasicAuthUser: "user",
      sf311BasicAuthPass: "pass",
    },
    fetchImpl,
  });
  await expect(
    client.updateServiceRequest({ SRnum: "123" }),
  ).resolves.toMatchObject({ updateId: "u1" });
  await expect(client.createServiceRequest({})).rejects.toThrow(
    "SF311_CREATESR_URL is required",
  );
  await expect(client.lookupResponsibleAgency("code")).rejects.toThrow(
    "SF311_AGENCY_LOOKUP_URL is required",
  );
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it.each([
  {},
  { UpdateID: 123 },
  { data: { UpdateID: 123 } },
  { return_code: null },
  { return_code: "" },
])(
  "rejects UpdateSR responses without explicit HUB confirmation: %j",
  async (body) => {
    const client = createSf311Client({
      config: {
        uploadBucket: "bucket",
        queueUrl: "queue",
        dynamoTable: "table",
        sf311UpdateSrUrl: "https://hub.test/update",
        sf311BasicAuthUser: "user",
        sf311BasicAuthPass: "pass",
      },
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
    });
    await expect(
      client.updateServiceRequest({ SRnum: "123" }),
    ).rejects.toMatchObject({
      name: "Sf311Error",
      code: "missing_return_code",
    });
  },
);

it.each([{ return_code: 0 }, { data: { return_code: "0" } }])(
  "accepts explicitly confirmed UpdateSR without requiring an update ID: %j",
  async (body) => {
    const client = createSf311Client({
      config: {
        uploadBucket: "bucket",
        queueUrl: "queue",
        dynamoTable: "table",
        sf311UpdateSrUrl: "https://hub.test/update",
        sf311BasicAuthUser: "user",
        sf311BasicAuthPass: "pass",
      },
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
    });
    await expect(
      client.updateServiceRequest({ SRnum: "123" }),
    ).resolves.toMatchObject({ updateId: null });
  },
);
