import { currentManagerOversight } from "../lib/site-manager-name.js";
import {
  readCompliancePeriods,
  projectSiteCompliance,
} from "../lib/site-compliance.js";
import { randomUUID } from "node:crypto";
import {
  siteContacts,
  siteManagerProfiles,
} from "../lib/site-admin-contacts.js";
import { updatePersonRecord } from "../lib/people.js";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getComplianceLetterBucket, getConfig } from "../config.js";
import {
  geocodeSiteAddress,
  locationFromSite,
  siteSearchItem,
  siteSearchSk,
} from "../domain/site-metadata.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { presignGet } from "../s3.js";
import { GeocodingError } from "../integrations/census-geocoder.js";
import {
  deriveAccessLevel,
  deriveSiteId,
  deriveActorId,
} from "../lib/principal.js";
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
    "duplicateUiRolloutVersion",
  ]) {
    delete publicSite[field];
  }
  const storedFeatureFlags =
    site.featureFlags && typeof site.featureFlags === "object"
      ? /** @type {Record<string, unknown>} */ (site.featureFlags)
      : {};
  publicSite.featureFlags = {
    // Presentation rollout is site-owned runtime configuration. Backend
    // matching remains independently controlled by the deployed
    // `enable_duplicate_detection` infrastructure flag.
    duplicateDetection: storedFeatureFlags.duplicateDetection !== false,
  };
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
 * PATCH /v1/site-admin — update Site details, public contacts, assigned manager
 * phones, or perimeter text. City Program Manager profiles remain read-only.
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
  if (section === "siteManagerPhone") {
    const assigned = (await siteManagerProfiles(siteId)).find(
      (entry) => entry.person?.personId === values.personId,
    );
    if (!assigned?.person)
      return jsonResponse(404, { error: "assigned_person_not_found" });
    if (typeof values.phone !== "string")
      return jsonResponse(400, { error: "invalid_phone" });
    const phone = values.phone.trim();
    const digits = phone.replace(/\D/g, "");
    if (
      phone &&
      !(
        digits.length === 10 ||
        (digits.length === 11 && digits.startsWith("1"))
      )
    )
      return jsonResponse(400, { error: "invalid_phone" });
    const assignment = assigned.assignment;
    try {
      await updatePersonRecord(
        assigned.person,
        { ...assigned.person, phone },
        deriveActorId(event),
        [
          {
            TableName: getConfig().dynamoTable,
            Key: { pk: assignment.pk, sk: assignment.sk },
            ConditionExpression:
              "#assignmentStatus = :assignmentActive" +
              (assignment.personId
                ? " AND personId = :assignmentPerson"
                : " AND programId = :assignmentProgram AND userId = :assignmentUser AND attribute_not_exists(personId)"),
            ExpressionAttributeNames: { "#assignmentStatus": "status" },
            ExpressionAttributeValues: {
              ":assignmentActive": "active",
              ...(assignment.personId
                ? { ":assignmentPerson": assignment.personId }
                : {
                    ":assignmentProgram": assignment.programId,
                    ":assignmentUser": assignment.userId,
                  }),
            },
          },
          {
            TableName: getConfig().dynamoTable,
            Key: siteMetaKey(siteId),
            ConditionExpression:
              "attribute_exists(pk) AND (attribute_not_exists(#siteStatus) OR #siteStatus <> :inactiveSite)",
            ExpressionAttributeNames: { "#siteStatus": "status" },
            ExpressionAttributeValues: { ":inactiveSite": "inactive" },
          },
        ],
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TransactionCanceledException" ||
          [
            "person_source_conflict",
            "person_update_limit_exceeded",
            "affiliation_not_found",
            "invalid_person_contact",
          ].includes(error.message))
      )
        return jsonResponse(409, { error: "person_update_conflict" });
      throw error;
    }
    return jsonResponse(200, { site: await siteAdminView(site) });
  }
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
  } else if (section === "publicContact" || section === "contactPerson") {
    // Older clients use contactPerson; keep that route writing the canonical public fields.
    const validation = validatePublicContact(values);
    if (!validation.ok || !validation.value) {
      return jsonResponse(400, { error: validation.error });
    }
    update = {
      UpdateExpression: "SET publicContact = :contact, updatedAt = :now",
      ExpressionAttributeValues: {
        ":contact": validation.value,
        ":now": now,
      },
    };
    site.publicContact = validation.value;
  } else if (section === "perimeter") {
    if (
      typeof values.perimeter !== "string" ||
      !values.perimeter.trim() ||
      values.perimeter.trim().length > 4000
    )
      return jsonResponse(400, { error: "invalid_perimeter" });
    site.perimeter = values.perimeter.trim();
    relatedWrites.push({
      Put: {
        TableName: getConfig().dynamoTable,
        Item: {
          pk: `SITE#${siteId}`,
          sk: `AUDIT#${now}#${randomUUID()}`,
          type: "siteAuditEvent",
          eventType: "perimeter_text_updated",
          siteId,
          actor: deriveActorId(event),
          createdAt: now,
        },
      },
    });
    update = {
      UpdateExpression:
        "SET perimeter = :perimeter, perimeterUpdatedAt = :now, perimeterUpdatedBy = :actor, perimeterUpdatedSource = :source, updatedAt = :now",
      ExpressionAttributeValues: {
        ":perimeter": site.perimeter,
        ":now": now,
        ":actor": deriveActorId(event),
        ":source": "good-neighbor",
      },
    };
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
      ConsistentRead: true,
    }),
  );
  return /** @type {Record<string, any> | undefined} */ (result.Item);
}

/**
 * @param {Record<string, any>} site
 * @returns {Promise<Record<string, any>>}
 */
async function siteAdminView(site) {
  const oversight = await currentManagerOversight(site.oversight || {});
  const canonical = projectSiteCompliance(
    site,
    await readCompliancePeriods(site.siteId),
  );
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
    publicContact: site.publicContact || {
      email: "",
      phone: "",
    },
    ...(await siteContacts(site.siteId)),
    oversight,
    compliance: canonical.compliance,
    compliancePeriods: canonical.compliancePeriods,
    letterState: canonical.letterState,
    perimeter: String(site.perimeter || ""),
    complianceLetters: await complianceLetterLinks(canonical.complianceLetters),
  };
}

/** @param {Record<string, any>} letters */
async function complianceLetterLinks(letters) {
  /** @param {Record<string, any> | null | undefined} letter */
  const link = async (letter) => {
    if (!letter || !letter.s3Key) return letter;
    return {
      ...letter,
      url: await presignGet({
        bucket: getComplianceLetterBucket(),
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
 * @returns {{ ok: boolean, error?: string, value?: { email: string, phone: string, phoneExtension: string } }}
 */
function validatePublicContact(values) {
  const value = {
    email: clean(values.email).toLowerCase(),
    phone: clean(values.phone),
    phoneExtension: clean(values.phoneExtension).slice(0, 20),
  };
  if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) {
    return { ok: false, error: "invalid_email" };
  }
  const digits = value.phone.replace(/\D/g, "");
  if (
    value.phone &&
    !(digits.length === 10 || (digits.length === 11 && digits[0] === "1"))
  ) {
    return { ok: false, error: "invalid_phone" };
  }
  const national = digits.length === 11 ? digits.slice(1) : digits;
  value.phone = national
    ? `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`
    : "";
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
