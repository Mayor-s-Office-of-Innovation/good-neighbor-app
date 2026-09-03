import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { getConfig } from "../config.js";

const SOURCE_AGENCY = "76";
const SENDING_AGENCY = "76";
const SF311_REQUEST_TIMEOUT_MS = 10_000;

/** @type {SecretsManagerClient | undefined} */
let secretsClient;

/** @type {Map<string, { username: string, password: string }>} */
const basicAuthCache = new Map();

/**
 * @param {Date} date
 * @returns {string}
 */
export function hubDateTime(date) {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/**
 * @param {string} value
 * @param {number} max
 * @returns {string}
 */
export function truncateHubField(value, max) {
  return String(value ?? "").slice(0, max);
}

/**
 * @param {object} params
 * @param {string} params.taskId
 * @param {string} params.serviceCode
 * @returns {string}
 */
export function sourceRequestId({ taskId, serviceCode }) {
  return truncateHubField(`${taskId}-${serviceCode}`.replaceAll(".", ""), 50);
}

/**
 * @param {object} params
 * @param {string} params.taskId
 * @param {string} params.serviceCode
 * @param {string} params.responsibleAgency
 * @param {string} params.problemDescription
 * @param {{ latitude: number, longitude: number }} params.location
 * @param {Date} params.now
 * @returns {Record<string, string>}
 */
export function buildCreateSrPayload({
  taskId,
  serviceCode,
  responsibleAgency,
  problemDescription,
  location,
  now,
}) {
  return {
    SourceAgency: SOURCE_AGENCY,
    SourceRequestID: sourceRequestId({ taskId, serviceCode }),
    SourceOperator: "Good Neighbor App",
    ResponsibleAgency: String(responsibleAgency),
    ResponsibleAgencyRequestID: "",
    SourceAgencyReceiveDate: hubDateTime(now),
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
    NatureofRequest: serviceCode,
    ProblemDescription: truncateHubField(problemDescription, 2000),
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
    Latitude: String(location.latitude),
    Longitude: String(location.longitude),
  };
}

/**
 * @param {object} params
 * @param {string} params.srNum
 * @param {string} params.imageUrl
 * @param {Date} params.now
 * @returns {Record<string, string>}
 */
export function buildAttachmentUpdatePayload({ srNum, imageUrl, now }) {
  return {
    SRnum: srNum,
    UpdateType: "8",
    SendingAgency: SENDING_AGENCY,
    SourceOperator: "Good Neighbor App",
    NumericSubType: "1",
    TextSubType: imageUrl,
    EffectiveDate: hubDateTime(now),
    ToAgencyDate: "",
    Notes: "",
  };
}

/**
 * @param {import("../config.js").AppConfig} config
 * @returns {Promise<{ username: string, password: string }>}
 */
export async function getSf311BasicAuth(config = getConfig()) {
  if (config.sf311BasicAuthUser && config.sf311BasicAuthPass) {
    return {
      username: config.sf311BasicAuthUser,
      password: config.sf311BasicAuthPass,
    };
  }

  const secretArn = config.sf311BasicAuthSecretArn;
  if (!secretArn) {
    throw new Error(
      "No SF311 Basic Auth configured: set SF311_BASIC_AUTH_SECRET_ARN or SF311_BASIC_AUTH_USER/SF311_BASIC_AUTH_PASS",
    );
  }

  const cached = basicAuthCache.get(secretArn);
  if (cached) return cached;

  secretsClient ??= new SecretsManagerClient({});
  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  if (!result.SecretString) {
    throw new Error(`SF311 Basic Auth secret ${secretArn} has no SecretString`);
  }

  const parsed = JSON.parse(result.SecretString);
  const username = parsed.username ?? parsed.user;
  const password = parsed.password ?? parsed.pass;
  if (typeof username !== "string" || typeof password !== "string") {
    throw new Error(
      "SF311 Basic Auth secret must be JSON with username/password fields",
    );
  }

  const value = { username, password };
  basicAuthCache.set(secretArn, value);
  return value;
}

/**
 * @param {{ username: string, password: string }} auth
 * @returns {string}
 */
function basicAuthHeader(auth) {
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
}

/**
 * @param {unknown} body
 * @param {string} serviceCode
 * @returns {string | null}
 */
export function findResponsibleAgencyInLookup(body, serviceCode) {
  /** @type {unknown[]} */
  const stack = [body];
  while (stack.length) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const item = /** @type {Record<string, unknown>} */ (value);
    const candidates = [
      item.NatureofRequest,
      item.NatureOfRequest,
      item.ServiceCode,
      item.serviceCode,
      item.service_code,
    ].map((candidate) => String(candidate ?? ""));
    if (candidates.includes(serviceCode)) {
      const agency =
        item.ResponsibleAgency ??
        item.responsibleAgency ??
        item.ResponsibleAgencyID ??
        item.agency_id ??
        item.AgencyID;
      if (agency !== undefined && agency !== null && String(agency)) {
        return String(agency);
      }
    }
    stack.push(...Object.values(item));
  }
  return null;
}

export class Sf311Error extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {number} [opts.status]
   * @param {string} [opts.code]
   * @param {unknown} [opts.body]
   * @param {unknown} [opts.request]
   */
  constructor(message, { status, code, body, request } = {}) {
    super(message);
    this.name = "Sf311Error";
    this.status = status;
    this.code = code;
    this.body = body;
    this.request = request;
  }
}

/**
 * @returns {{ signal: AbortSignal, cancel: () => void }}
 */
function sf311TimeoutSignal() {
  if (typeof AbortSignal.timeout === "function") {
    return {
      signal: AbortSignal.timeout(SF311_REQUEST_TIMEOUT_MS),
      cancel: () => {},
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SF311_REQUEST_TIMEOUT_MS);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbortError(error) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/**
 * @param {object} options
 * @param {import("../config.js").AppConfig} [options.config]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {{ lookupResponsibleAgency: (serviceCode: string) => Promise<string>, createServiceRequest: (payload: Record<string, string>) => Promise<{ srNum: string, response: unknown }>, updateServiceRequest: (payload: Record<string, string>) => Promise<{ updateId: string | null, response: unknown }> }}
 */
export function createSf311Client({ config = getConfig(), fetchImpl = fetch }) {
  if (!config.sf311CreateSrUrl) {
    throw new Error("SF311_CREATESR_URL is required");
  }
  if (!config.sf311AgencyLookupUrl) {
    throw new Error("SF311_AGENCY_LOOKUP_URL is required");
  }
  const createSrUrl = config.sf311CreateSrUrl;
  const updateSrUrl = config.sf311UpdateSrUrl;
  const agencyLookupUrl = config.sf311AgencyLookupUrl;

  /**
   * @param {Response} res
   * @returns {Promise<unknown>}
   */
  const readJson = async (res) => {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  /**
   * @param {string} url
   * @param {RequestInit} init
   * @param {string} operation
   * @param {unknown} [request]
   * @returns {Promise<Response>}
   */
  const fetchSf311 = async (url, init, operation, request) => {
    const timeout = sf311TimeoutSignal();
    try {
      return await fetchImpl(url, { ...init, signal: timeout.signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Sf311Error(`SF311 ${operation} timed out`, {
          code: "sf311_timeout",
          request,
        });
      }
      throw error;
    } finally {
      timeout.cancel();
    }
  };

  return {
    /**
     * @param {string} serviceCode
     * @returns {Promise<string>}
     */
    async lookupResponsibleAgency(serviceCode) {
      const auth = await getSf311BasicAuth(config);
      const res = await fetchSf311(
        agencyLookupUrl,
        {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: basicAuthHeader(auth),
          },
        },
        "agency lookup",
        { serviceCode },
      );
      const body = await readJson(res);
      if (!res.ok) {
        throw new Sf311Error(`SF311 agency lookup returned ${res.status}`, {
          status: res.status,
          body,
        });
      }
      const agency = findResponsibleAgencyInLookup(body, serviceCode);
      if (agency) return agency;
      if (config.sf311DefaultResponsibleAgency) {
        return config.sf311DefaultResponsibleAgency;
      }
      throw new Sf311Error(`No ResponsibleAgency found for ${serviceCode}`, {
        code: "responsible_agency_not_found",
        body,
      });
    },

    /**
     * @param {Record<string, string>} payload
     * @returns {Promise<{ srNum: string | null, response: unknown }>}
     */
    async createServiceRequest(payload) {
      const auth = await getSf311BasicAuth(config);
      const res = await fetchSf311(
        createSrUrl,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: basicAuthHeader(auth),
          },
          body: JSON.stringify(payload),
        },
        "CreateSR",
        payload,
      );
      const body = await readJson(res);
      const data =
        body && typeof body === "object" && "data" in body
          ? /** @type {{ data?: Record<string, unknown> }} */ (body).data
          : body;
      const returnCode =
        data && typeof data === "object"
          ? String(
              /** @type {Record<string, unknown>} */ (data).return_code ?? "",
            )
          : "";
      if (!res.ok || (returnCode && returnCode !== "0")) {
        throw new Sf311Error("SF311 CreateSR failed", {
          status: res.status,
          code: returnCode || undefined,
          body,
          request: payload,
        });
      }
      const srNum =
        data && typeof data === "object"
          ? /** @type {Record<string, unknown>} */ (data).SRNum
          : null;
      const normalizedSrNum = srNum == null ? "" : String(srNum).trim();
      if (!normalizedSrNum) {
        throw new Sf311Error("SF311 CreateSR response missing SRNum", {
          status: res.status,
          code: "missing_srnum",
          body,
          request: payload,
        });
      }
      return { srNum: normalizedSrNum, response: body };
    },

    /**
     * @param {Record<string, string>} payload
     * @returns {Promise<{ updateId: string | null, response: unknown }>}
     */
    async updateServiceRequest(payload) {
      if (!updateSrUrl) {
        throw new Error("SF311_UPDATESR_URL is required");
      }
      const auth = await getSf311BasicAuth(config);
      const res = await fetchSf311(
        updateSrUrl,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: basicAuthHeader(auth),
          },
          body: JSON.stringify(payload),
        },
        "UpdateSR",
        payload,
      );
      const body = await readJson(res);
      const data =
        body && typeof body === "object" && "data" in body
          ? /** @type {{ data?: Record<string, unknown> }} */ (body).data
          : body;
      const returnCode =
        data && typeof data === "object"
          ? String(
              /** @type {Record<string, unknown>} */ (data).return_code ?? "",
            )
          : "";
      if (!res.ok || (returnCode && returnCode !== "0")) {
        throw new Sf311Error("SF311 UpdateSR failed", {
          status: res.status,
          code: returnCode || undefined,
          body,
          request: payload,
        });
      }
      const updateId =
        data && typeof data === "object"
          ? /** @type {Record<string, unknown>} */ (data).UpdateID
          : null;
      return {
        updateId: updateId == null ? null : String(updateId),
        response: body,
      };
    },
  };
}
