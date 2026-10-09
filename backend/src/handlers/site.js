import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import {
  geocodeSiteAddress,
  locationFromSite,
  siteSearchItem,
  siteSearchSk,
} from "../domain/site-metadata.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { presignGet } from "../s3.js";
import { GeocodingError } from "../integrations/census-geocoder.js";
import { deriveAccessLevel, deriveSiteId } from "../lib/principal.js";
import { siteMetaKey } from "./keys.js";

const PROVIDER_SITES_PAGE_SIZE = 25;
const SITE_METADATA_CONCURRENCY = 5;

/**
 * A cursor can select only a later membership in the caller's own provider
 * partition; the provider key itself is always derived from the bound site.
 * @param {string} value
 * @returns {string | null}
 */
function decodeMembershipCursor(value) {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const sk = Buffer.from(value, "base64url").toString("utf8");
  if (
    !sk.startsWith("SITE#") ||
    sk.length > 256 ||
    Array.from(sk).some((character) => character.charCodeAt(0) < 32) ||
    Buffer.from(sk).toString("base64url") !== value
  ) {
    return null;
  }
  return sk;
}

/**
 * GET /v1/site — the bound site's metadata (`SITE#<id>` / `#META`). Returns a
 * minimal default record when nothing has been written yet so the client
 * always has a name to show.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const getSite = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const result = await ddb.send(
    new GetCommand({
      TableName: dynamoTable,
      Key: siteMetaKey(siteId),
    }),
  );

  const site = result.Item || {
    ...siteMetaKey(siteId),
    type: "site",
    siteId,
    name: "Your site",
  };
  const publicSite = { ...site };
  for (const field of [
    "contactPerson",
    "oversight",
    "compliance",
    "perimeter",
    "complianceLetters",
    "addressParts",
  ]) {
    delete publicSite[field];
  }
  return jsonResponse(200, { site: publicSite });
};

/**
 * GET /v1/site-admin — full site information for admin-access devices.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const getSiteAdmin = async (event) => {
  if (deriveAccessLevel(event) !== "manager") {
    return jsonResponse(403, { error: "admin_access_required" });
  }
  const site = await loadSite(deriveSiteId(event));
  if (!site || site.status === "inactive") {
    return jsonResponse(404, { error: "site_not_found" });
  }
  return jsonResponse(200, { site: await siteAdminView(site) });
};

/**
 * PATCH /v1/site-admin — update only the two staff-editable sections.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const updateSiteAdmin = async (event) => {
  if (deriveAccessLevel(event) !== "manager") {
    return jsonResponse(403, { error: "admin_access_required" });
  }
  let body;
  try {
    body = /** @type {Record<string, unknown>} */ (readJsonBody(event) ?? {});
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const siteId = deriveSiteId(event);
  const site = await loadSite(siteId);
  if (!site || site.status === "inactive") {
    return jsonResponse(404, { error: "site_not_found" });
  }

  const section = body.section;
  const values = /** @type {Record<string, unknown>} */ (body.values ?? {});
  const now = new Date().toISOString();
  let update;
  /** @type {import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]} */
  const relatedWrites = [];
  if (section === "siteDetails") {
    const validation = validateSiteDetails(values);
    if (!validation.ok || !validation.value) {
      return jsonResponse(400, { error: validation.error });
    }
    const validated = validation.value;
    const previousName = String(site.name || "");
    const address = validated.address;
    const formattedAddress = formatAddress(address);
    const existingLocation = locationFromSite(site);
    const geocoded =
      formattedAddress !== site.address ||
      existingLocation instanceof GeocodingError
        ? await geocodeSiteAddress(formattedAddress)
        : existingLocation;
    if (geocoded instanceof GeocodingError) {
      return jsonResponse(422, { error: geocoded.code });
    }
    update = {
      UpdateExpression:
        "SET #name = :name, #address = :address, addressParts = :parts, #location = :location, geocodedAddress = :geocodedAddress, updatedAt = :now",
      ExpressionAttributeNames: {
        "#name": "name",
        "#address": "address",
        "#location": "location",
      },
      ExpressionAttributeValues: {
        ":name": validated.name,
        ":address": formattedAddress,
        ":parts": address,
        ":location": {
          latitude: geocoded.latitude,
          longitude: geocoded.longitude,
        },
        ":geocodedAddress": geocoded.matchedAddress,
        ":now": now,
      },
    };
    site.name = validated.name;
    site.address = formattedAddress;
    site.addressParts = address;
    site.location = {
      latitude: geocoded.latitude,
      longitude: geocoded.longitude,
    };
    site.geocodedAddress = geocoded.matchedAddress;

    if (site.providerId) {
      relatedWrites.push({
        Update: {
          TableName: getConfig().dynamoTable,
          Key: {
            pk: `PROVIDER#${site.providerId}`,
            sk: `SITE#${siteId}`,
          },
          UpdateExpression: "SET siteName = :name, updatedAt = :now",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: {
            ":name": validated.name,
            ":now": now,
          },
        },
      });
    }
    if (site.status !== "inactive") {
      const oldSearchSk = siteSearchSk(previousName, siteId);
      const nextSearchSk = siteSearchSk(validated.name, siteId);
      if (oldSearchSk !== nextSearchSk) {
        relatedWrites.push({
          Delete: {
            TableName: getConfig().dynamoTable,
            Key: { pk: "SITE_SEARCH#ACTIVE", sk: oldSearchSk },
          },
        });
      }
      relatedWrites.push({
        Put: {
          TableName: getConfig().dynamoTable,
          Item: siteSearchItem(
            siteId,
            validated.name,
            String(site.providerId || ""),
            String(site.providerName || ""),
            String(site.providerSiteId || ""),
            now,
          ),
        },
      });
    }
  } else if (section === "contactPerson") {
    const validation = validateContactPerson(values);
    if (!validation.ok || !validation.value) {
      return jsonResponse(400, { error: validation.error });
    }
    update = {
      UpdateExpression: "SET contactPerson = :contact, updatedAt = :now",
      ExpressionAttributeValues: {
        ":contact": validation.value,
        ":now": now,
      },
    };
    site.contactPerson = validation.value;
  } else {
    return jsonResponse(400, { error: "invalid_section" });
  }

  const siteUpdate = {
    TableName: getConfig().dynamoTable,
    Key: siteMetaKey(siteId),
    ConditionExpression: site.updatedAt
      ? "attribute_exists(pk) AND updatedAt = :expectedUpdatedAt"
      : "attribute_exists(pk) AND attribute_not_exists(updatedAt)",
    ...update,
  };
  if (site.updatedAt) {
    /** @type {Record<string, unknown>} */ (
      siteUpdate.ExpressionAttributeValues
    )[":expectedUpdatedAt"] = site.updatedAt;
  }
  try {
    if (relatedWrites.length) {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [{ Update: siteUpdate }, ...relatedWrites],
        }),
      );
    } else {
      await ddb.send(new UpdateCommand(siteUpdate));
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TransactionCanceledException" ||
        error.name === "ConditionalCheckFailedException")
    ) {
      return jsonResponse(409, { error: "site_update_conflict" });
    }
    throw error;
  }
  return jsonResponse(200, { site: await siteAdminView(site) });
};

/**
 * @param {string} siteId
 * @returns {Promise<Record<string, any> | undefined>}
 */
async function loadSite(siteId) {
  const result = await ddb.send(
    new GetCommand({
      TableName: getConfig().dynamoTable,
      Key: siteMetaKey(siteId),
    }),
  );
  return /** @type {Record<string, any> | undefined} */ (result.Item);
}

/**
 * @param {Record<string, any>} site
 * @returns {Promise<Record<string, any>>}
 */
async function siteAdminView(site) {
  const compliance = site.compliance || {};
  const activeCompliance =
    compliance.periodEnd && compliance.periodEnd < pacificIsoDate()
      ? { perimeterChecksRequired: false }
      : compliance;
  return {
    siteId: site.siteId,
    name: String(site.name || "Your site"),
    address: site.addressParts || {
      streetNumber: "",
      streetAddress: "",
      secondLine: "",
      city: "",
      state: "",
      zip: "",
    },
    contactPerson: site.contactPerson || {
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
    },
    oversight: site.oversight || {},
    compliance: activeCompliance,
    perimeter: String(site.perimeter || ""),
    complianceLetters: await complianceLetterLinks(
      site.complianceLetters || { current: null, past: [] },
    ),
  };
}

function pacificIsoDate() {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

/** @param {Record<string, any>} letters */
async function complianceLetterLinks(letters) {
  /** @param {Record<string, any> | null | undefined} letter */
  const link = async (letter) => {
    if (!letter || !letter.s3Key) return letter;
    return {
      ...letter,
      url: await presignGet({
        bucket: getConfig().uploadBucket,
        key: letter.s3Key,
        expiresIn: 300,
      }),
    };
  };
  return {
    current: await link(letters.current),
    past: await Promise.all((letters.past || []).map(link)),
  };
}

/**
 * @param {Record<string, unknown>} values
 * @returns {{ ok: boolean, error?: string, value?: { name: string, address: Record<string, string> } }}
 */
function validateSiteDetails(values) {
  const name = clean(values.name);
  const address = /** @type {Record<string, unknown>} */ (values.address ?? {});
  const value = {
    name,
    address: {
      streetNumber: clean(address.streetNumber),
      streetAddress: clean(address.streetAddress),
      secondLine: clean(address.secondLine),
      city: clean(address.city),
      state: clean(address.state).toUpperCase(),
      zip: clean(address.zip),
    },
  };
  if (!name) return { ok: false, error: "site_name_required" };
  if (
    !value.address.streetNumber ||
    !value.address.streetAddress ||
    !value.address.city ||
    !/^[A-Z]{2}$/.test(value.address.state) ||
    !/^\d{5}(?:-\d{4})?$/.test(value.address.zip)
  ) {
    return { ok: false, error: "invalid_address" };
  }
  return { ok: true, value };
}

/**
 * @param {Record<string, unknown>} values
 * @returns {{ ok: boolean, error?: string, value?: { firstName: string, lastName: string, email: string, phone: string } }}
 */
function validateContactPerson(values) {
  const value = {
    firstName: clean(values.firstName),
    lastName: clean(values.lastName),
    email: clean(values.email).toLowerCase(),
    phone: clean(values.phone),
  };
  if (!value.firstName || !value.lastName) {
    return { ok: false, error: "contact_name_required" };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) {
    return { ok: false, error: "invalid_email" };
  }
  const digits = value.phone.replace(/\D/g, "");
  if (!(digits.length === 10 || (digits.length === 11 && digits[0] === "1"))) {
    return { ok: false, error: "invalid_phone" };
  }
  return { ok: true, value };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function clean(value) {
  return typeof value === "string" ? value.trim().slice(0, 250) : "";
}

/**
 * @param {Record<string, string>} address
 * @returns {string}
 */
function formatAddress(address) {
  return [
    `${address.streetNumber} ${address.streetAddress}`.trim(),
    address.secondLine,
    `${address.city}, ${address.state} ${address.zip}`.trim(),
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * GET /v1/provider-sites — page through active sites under the caller's provider.
 * The provider is read from the authenticated site's metadata, never from a
 * request parameter, so a device cannot enumerate another provider's sites.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const listProviderSites = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const current = await ddb.send(
    new GetCommand({ TableName: dynamoTable, Key: siteMetaKey(siteId) }),
  );
  const site = current.Item;
  if (!site || site.status === "inactive") {
    return jsonResponse(404, { error: "site_not_found" });
  }
  const providerId = String(site.providerId || "");
  const rawCursor = event.queryStringParameters?.cursor || "";
  const cursorSk = rawCursor ? decodeMembershipCursor(rawCursor) : "";
  if (rawCursor && !cursorSk) {
    return jsonResponse(400, { error: "invalid_cursor" });
  }
  if (!providerId) {
    return jsonResponse(200, {
      providerId: "",
      providerName: String(site.providerName || ""),
      sites: [{ siteId, name: String(site.name || "Your site") }],
      nextCursor: null,
    });
  }

  const providerKey = `PROVIDER#${providerId}`;
  const page = await ddb.send(
    new QueryCommand({
      TableName: dynamoTable,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": providerKey,
        ":prefix": "SITE#",
      },
      Limit: PROVIDER_SITES_PAGE_SIZE,
      ...(cursorSk
        ? { ExclusiveStartKey: { pk: providerKey, sk: cursorSk } }
        : {}),
    }),
  );

  const activeMemberships = (page.Items || []).filter(
    (item) => item.status === "active" && item.siteId,
  );
  /** @type {{ siteId: string, name: string }[]} */
  const verifiedSites = [];
  for (
    let index = 0;
    index < activeMemberships.length;
    index += SITE_METADATA_CONCURRENCY
  ) {
    const group = await Promise.all(
      activeMemberships
        .slice(index, index + SITE_METADATA_CONCURRENCY)
        .map(async (membership) => {
          const memberSiteId = String(membership.siteId);
          const result = await ddb.send(
            new GetCommand({
              TableName: dynamoTable,
              Key: siteMetaKey(memberSiteId),
            }),
          );
          const metadata = result.Item;
          if (
            !metadata ||
            metadata.status === "inactive" ||
            String(metadata.providerId || "") !== providerId
          ) {
            return null;
          }
          return {
            siteId: memberSiteId,
            name: String(metadata.name || membership.siteName || memberSiteId),
          };
        }),
    );
    verifiedSites.push(...group.filter((member) => member !== null));
  }
  const sites = verifiedSites.sort((a, b) => a.name.localeCompare(b.name));
  return jsonResponse(200, {
    providerId,
    providerName: String(site.providerName || providerId),
    sites,
    nextCursor: page.LastEvaluatedKey?.sk
      ? Buffer.from(String(page.LastEvaluatedKey.sk)).toString("base64url")
      : null,
  });
};
