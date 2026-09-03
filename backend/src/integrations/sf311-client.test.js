import { describe, expect, it, vi } from "vitest";
import {
  buildAttachmentUpdatePayload,
  buildCreateSrPayload,
  createSf311Client,
  findResponsibleAgencyInLookup,
  hubDateTime,
  Sf311Error,
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
    const timeout = new DOMException("Timed out", "TimeoutError");
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

    await expect(client.lookupResponsibleAgency("1.1.4.7.20.0")).rejects.toMatchObject({
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
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
