import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { getConfig, getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse } from "../http.js";
import {
  deleteObject,
  headObject,
  presignGet,
  presignPut,
  setObjectTags,
} from "../s3.js";
import { GeocodingError } from "../integrations/census-geocoder.js";
import {
  geocodeSiteAddress,
  locationFromSite,
  siteSearchItem,
  siteSearchSk,
} from "../domain/site-metadata.js";
import {
  issueSetupCode,
  normalizeEmail,
  revokePendingSetupCodesForSite,
} from "./setup-codes.js";
import { adminOnly, supervisorOnly } from "../lib/admin-auth.js";

/** GET /admin/v1/program-managers — non-authenticating domain directory. */
/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const listCityProgramManagers = (event) =>
  adminOnly(event, async () => {
    const items = await queryAll({
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: {
        ":pk": "ADMIN_DIRECTORY#PROGRAM_MANAGERS",
      },
    });
    return jsonResponse(200, {
      programManagers: items.map(publicProgramManager),
    });
  });

/** POST /admin/v1/program-managers — add a non-authenticating domain contact. */
/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const createCityProgramManager = (event) =>
  supervisorOnly(event, async (body) => {
    const firstName = cleanText(body.firstName);
    const lastName = cleanText(body.lastName);
    const email = cleanText(body.email).toLowerCase();
    const phone = normalizePhone(body.phone);
    if (!firstName || !lastName) {
      return jsonResponse(400, { error: "name_required" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse(400, { error: "valid_email_required" });
    }
    if (!phone) return jsonResponse(400, { error: "valid_phone_required" });
    const now = new Date().toISOString();
    const item = {
      pk: "ADMIN_DIRECTORY#PROGRAM_MANAGERS",
      sk: `MANAGER#${email}`,
      type: "cityProgramManager",
      userId: randomUUID(),
      firstName,
      lastName,
      name: `${firstName} ${lastName}`,
      email,
      phone,
      createdAt: now,
      updatedAt: now,
    };
    await ddb.send(
      new PutCommand({
        TableName: getDynamoTableName(),
        Item: item,
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return jsonResponse(201, {
      programManager: publicProgramManager(item),
    });
  });

/** PATCH /admin/v1/program-managers/{userId} — update shared contact details. */
/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const updateCityProgramManager = (event) =>
  adminOnly(event, async (body) => {
    const userId = event.pathParameters?.userId ?? "";
    const phone = normalizePhone(body.phone);
    if (!phone) return jsonResponse(400, { error: "valid_phone_required" });
    const items = await queryAll({
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "ADMIN_DIRECTORY#PROGRAM_MANAGERS" },
    });
    const manager = items.find((item) => item.userId === userId);
    if (!manager)
      return jsonResponse(404, { error: "program_manager_not_found" });
    const result = await ddb.send(
      new UpdateCommand({
        TableName: getDynamoTableName(),
        Key: { pk: manager.pk, sk: manager.sk },
        UpdateExpression: "SET phone = :phone, updatedAt = :now",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeValues: {
          ":phone": phone,
          ":now": new Date().toISOString(),
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return jsonResponse(200, {
      programManager: publicProgramManager(
        result.Attributes || { ...manager, phone },
      ),
    });
  });

/**
 * GET /admin/v1/providers
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const listProviders = (event) =>
  adminOnly(event, async () => {
    const providers = await queryAll({
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "PROVIDER_SEARCH#ACTIVE" },
      Limit: 100,
    });
    return jsonResponse(200, { providers });
  });

/**
 * POST /admin/v1/providers
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const createProvider = (event) =>
  supervisorOnly(event, async (body) => {
    const name = String(body.name ?? "").trim();
    if (!name) return jsonResponse(400, { error: "name_required" });
    const providerId = slug(body.providerId, name);
    const now = new Date().toISOString();
    const item = {
      pk: `PROVIDER#${providerId}`,
      sk: "#META",
      type: "provider",
      entityType: "PROVIDER",
      providerId,
      name,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    await Promise.all([
      ddb.send(
        new PutCommand({
          TableName: getDynamoTableName(),
          Item: item,
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      ),
      putProviderSearch(providerId, name, now),
    ]);
    return jsonResponse(201, { provider: item });
  });

/**
 * GET /admin/v1/providers/{providerId}
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const getProvider = (event) =>
  adminOnly(event, async () => {
    const providerId = event.pathParameters?.providerId ?? "";
    const [provider, sites] = await Promise.all([
      ddb.send(
        new GetCommand({
          TableName: getDynamoTableName(),
          Key: { pk: `PROVIDER#${providerId}`, sk: "#META" },
        }),
      ),
      ddb.send(
        new QueryCommand({
          TableName: getDynamoTableName(),
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :site)",
          ExpressionAttributeValues: {
            ":pk": `PROVIDER#${providerId}`,
            ":site": "SITE#",
          },
        }),
      ),
    ]);
    if (!provider.Item) return jsonResponse(404, { error: "not_found" });
    return jsonResponse(200, {
      provider: provider.Item,
      sites: sites.Items ?? [],
    });
  });

/**
 * PATCH /admin/v1/providers/{providerId}
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const updateProvider = (event) =>
  adminOnly(event, async (body) => {
    const providerId = event.pathParameters?.providerId ?? "";
    const name = String(body.name ?? "").trim();
    if (!name) return jsonResponse(400, { error: "name_required" });
    const now = new Date().toISOString();
    const res = await ddb.send(
      new UpdateCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `PROVIDER#${providerId}`, sk: "#META" },
        UpdateExpression: "SET #name = :name, updatedAt = :now",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#name": "name" },
        ExpressionAttributeValues: { ":name": name, ":now": now },
        ReturnValues: "ALL_NEW",
      }),
    );
    await putProviderSearch(providerId, name, now);
    return jsonResponse(200, { provider: res.Attributes });
  });

/**
 * DELETE /admin/v1/providers/{providerId}
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const deactivateProvider = (event) =>
  supervisorOnly(event, async () => {
    const providerId = event.pathParameters?.providerId ?? "";
    const now = new Date().toISOString();
    const res = await ddb.send(
      new UpdateCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `PROVIDER#${providerId}`, sk: "#META" },
        UpdateExpression: "SET #status = :inactive, updatedAt = :now",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":inactive": "inactive",
          ":now": now,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    await ddb.send(
      new DeleteCommand({
        TableName: getDynamoTableName(),
        Key: { pk: "PROVIDER_SEARCH#ACTIVE", sk: providerId },
      }),
    );
    return jsonResponse(200, { provider: res.Attributes });
  });

/**
 * POST /admin/v1/providers/{providerId}/sites
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const createSite = (event) =>
  supervisorOnly(event, async (body) => {
    const providerId = event.pathParameters?.providerId ?? "";
    const name = String(body.name ?? "").trim();
    if (!name) return jsonResponse(400, { error: "name_required" });
    const address = normalizeAddress(body.address);
    if (!address) return jsonResponse(400, { error: "address_required" });
    const provider = await ddb.send(
      new GetCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `PROVIDER#${providerId}`, sk: "#META" },
      }),
    );
    if (!provider.Item || provider.Item.status === "inactive") {
      return jsonResponse(404, { error: "provider_not_found" });
    }
    const leadProgramId = cleanText(body.leadProgramId);
    const primaryContactUserId = cleanText(body.primaryContactUserId);
    const addressParts =
      body.addressParts === undefined
        ? null
        : normalizeAddressParts(body.addressParts);
    if (body.addressParts !== undefined && !addressParts) {
      return jsonResponse(400, { error: "invalid_address" });
    }
    const publicContact =
      body.publicContact === undefined
        ? null
        : normalizePublicContact(body.publicContact);
    if (body.publicContact !== undefined && !publicContact) {
      return jsonResponse(400, { error: "invalid_public_contact" });
    }
    const siteType = normalizeSiteType(body.siteType);
    if (body.siteType !== undefined && body.siteType !== "" && !siteType) {
      return jsonResponse(400, { error: "invalid_site_type" });
    }
    let program = null;
    let primaryContact = null;
    if (leadProgramId) {
      const result = await ddb.send(
        new GetCommand({
          TableName: getDynamoTableName(),
          Key: { pk: `PROGRAM#${leadProgramId}`, sk: "#META" },
        }),
      );
      program = result.Item;
      if (
        !program ||
        program.status === "inactive" ||
        program.providerId !== providerId
      ) {
        return jsonResponse(400, { error: "incompatible_program" });
      }
      if (primaryContactUserId) {
        const user = await ddb.send(
          new GetCommand({
            TableName: getDynamoTableName(),
            Key: {
              pk: `PROGRAM#${leadProgramId}`,
              sk: `USER#${primaryContactUserId}`,
            },
          }),
        );
        primaryContact = user.Item;
        if (!primaryContact || primaryContact.status === "inactive") {
          return jsonResponse(400, { error: "invalid_internal_site_contact" });
        }
      }
    } else if (primaryContactUserId) {
      return jsonResponse(400, { error: "site_program_required" });
    }
    const geocoded = await geocodeSiteAddress(address);
    if (geocoded instanceof GeocodingError) {
      return jsonResponse(422, { error: geocoded.code });
    }
    const siteId = slug(body.siteId, `${providerId}-${name}`);
    const providerSiteId = String(
      body.providerSiteId ?? `provider-site-${siteId}`,
    );
    const now = new Date().toISOString();
    const site = {
      pk: `SITE#${siteId}`,
      sk: "#META",
      type: "site",
      entityType: "SITE",
      siteId,
      name,
      address,
      location: {
        latitude: geocoded.latitude,
        longitude: geocoded.longitude,
      },
      geocodedAddress: geocoded.matchedAddress,
      ...(addressParts ? { addressParts } : {}),
      ...(publicContact ? { publicContact } : {}),
      ...(siteType ? { siteType } : {}),
      providerId,
      providerName: provider.Item.name,
      ...(program ? { leadProgramId, programName: String(program.name) } : {}),
      ...(primaryContact
        ? {
            primaryContactUserId,
            primaryContact: {
              firstName: primaryContact.firstName,
              lastName: primaryContact.lastName,
              phone: primaryContact.phone,
              email: primaryContact.email,
            },
          }
        : {}),
      providerSiteId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    const membership = {
      pk: `PROVIDER#${providerId}`,
      sk: `SITE#${siteId}`,
      type: "providerSiteMembership",
      providerId,
      providerName: provider.Item.name,
      siteId,
      siteName: name,
      providerSiteId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    const tableName = getDynamoTableName();
    /** @type {import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]} */
    const transactItems = [
      {
        Put: {
          TableName: tableName,
          Item: site,
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: membership,
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: siteSearchItem(
            siteId,
            name,
            providerId,
            provider.Item.name,
            providerSiteId,
            now,
          ),
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        },
      },
    ];
    if (program) {
      transactItems.push({
        Put: {
          TableName: tableName,
          Item: {
            pk: `PROGRAM#${leadProgramId}`,
            sk: `SITE#${siteId}`,
            type: "programSiteMembership",
            programId: leadProgramId,
            programName: program.name,
            siteId,
            siteName: name,
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        },
      });
    }
    if (primaryContact) {
      transactItems.push(
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: `SITE#${siteId}`,
              sk: `ASSIGNED_USER#${primaryContactUserId}`,
              type: "siteUserAssignment",
              siteId,
              programId: leadProgramId,
              userId: primaryContactUserId,
              firstName: primaryContact.firstName,
              lastName: primaryContact.lastName,
              phone: primaryContact.phone,
              email: primaryContact.email,
              status: "active",
              createdAt: now,
              updatedAt: now,
            },
            ConditionExpression:
              "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          },
        },
        {
          Update: {
            TableName: tableName,
            Key: {
              pk: `PROGRAM#${leadProgramId}`,
              sk: `USER#${primaryContactUserId}`,
            },
            UpdateExpression:
              "ADD siteAssignmentCount :one SET updatedAt = :now",
            ConditionExpression: "attribute_exists(pk) AND #status = :active",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":one": 1,
              ":now": now,
              ":active": "active",
            },
          },
        },
      );
    }
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: transactItems,
      }),
    );
    return jsonResponse(201, { site });
  });

/**
 * GET /admin/v1/sites/{siteId}
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const getAdminSite = (event) =>
  adminOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const res = await ddb.send(
      new QueryCommand({
        TableName: getDynamoTableName(),
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `SITE#${siteId}` },
      }),
    );
    if (!res.Items?.length) return jsonResponse(404, { error: "not_found" });
    const items = await Promise.all(
      res.Items.map(async (item) => {
        if (item.sk !== "#META" || !item.complianceLetters) return item;
        /** @param {Record<string, any> | null | undefined} letter */
        const link = async (letter) => {
          if (!letter?.s3Key) return letter;
          const [url, previewUrl] = await Promise.all([
            presignGet({
              bucket: getConfig().uploadBucket,
              key: letter.s3Key,
              expiresIn: 300,
            }),
            letter.previewS3Key
              ? presignGet({
                  bucket: getConfig().uploadBucket,
                  key: letter.previewS3Key,
                  expiresIn: 300,
                })
              : Promise.resolve(""),
          ]);
          return { ...letter, url, ...(previewUrl ? { previewUrl } : {}) };
        };
        return {
          ...item,
          complianceLetters: {
            current: await link(item.complianceLetters.current),
            past: await Promise.all(
              (item.complianceLetters.past || []).map(link),
            ),
          },
        };
      }),
    );
    return jsonResponse(200, { items });
  });

/**
 * POST /admin/v1/sites/{siteId}/reassign
 * Changes only the Site's Provider/Program relationships. Site identity,
 * device credentials, checks, tasks, and access generations are untouched.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const reassignSite = (event) =>
  supervisorOnly(event, async (body) => {
    const siteId = event.pathParameters?.siteId ?? "";
    const providerId = cleanText(body.providerId);
    const leadProgramId = cleanText(body.leadProgramId);
    if (!providerId || !leadProgramId) {
      return jsonResponse(400, { error: "provider_and_program_required" });
    }
    const tableName = getDynamoTableName();
    const [siteResult, providerResult, programResult] = await Promise.all([
      ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `SITE#${siteId}`, sk: "#META" },
        }),
      ),
      ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `PROVIDER#${providerId}`, sk: "#META" },
        }),
      ),
      ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `PROGRAM#${leadProgramId}`, sk: "#META" },
        }),
      ),
    ]);
    const site = siteResult.Item;
    const provider = providerResult.Item;
    const program = programResult.Item;
    if (!site || site.status === "inactive") {
      return jsonResponse(404, { error: "site_not_found" });
    }
    if (!provider || provider.status === "inactive") {
      return jsonResponse(404, { error: "provider_not_found" });
    }
    if (
      !program ||
      program.status === "inactive" ||
      program.providerId !== providerId
    ) {
      return jsonResponse(400, { error: "incompatible_program" });
    }
    if (
      site.providerId === providerId &&
      site.leadProgramId === leadProgramId
    ) {
      return jsonResponse(200, { site, unchanged: true });
    }
    const now = new Date().toISOString();
    /** @type {import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]} */
    const items = [
      {
        Update: {
          TableName: tableName,
          Key: { pk: `SITE#${siteId}`, sk: "#META" },
          UpdateExpression:
            "SET providerId = :providerId, providerName = :providerName, leadProgramId = :programId, programName = :programName, updatedAt = :now REMOVE programMigrationRunId",
          ConditionExpression: site.updatedAt
            ? "attribute_exists(pk) AND updatedAt = :expectedUpdatedAt"
            : "attribute_exists(pk)",
          ExpressionAttributeValues: {
            ":providerId": providerId,
            ":providerName": provider.name,
            ":programId": leadProgramId,
            ":programName": program.name,
            ":now": now,
            ...(site.updatedAt ? { ":expectedUpdatedAt": site.updatedAt } : {}),
          },
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: `PROVIDER#${providerId}`,
            sk: `SITE#${siteId}`,
            type: "providerSiteMembership",
            providerId,
            providerName: provider.name,
            siteId,
            siteName: site.name,
            providerSiteId: site.providerSiteId,
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: `PROGRAM#${leadProgramId}`,
            sk: `SITE#${siteId}`,
            type: "programSiteMembership",
            programId: leadProgramId,
            programName: program.name,
            siteId,
            siteName: site.name,
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: siteSearchItem(
            siteId,
            String(site.name),
            providerId,
            String(provider.name),
            String(site.providerSiteId ?? ""),
            now,
          ),
        },
      },
    ];
    if (site.providerId && site.providerId !== providerId) {
      items.push({
        Delete: {
          TableName: tableName,
          Key: { pk: `PROVIDER#${site.providerId}`, sk: `SITE#${siteId}` },
        },
      });
    }
    if (site.leadProgramId && site.leadProgramId !== leadProgramId) {
      items.push({
        Delete: {
          TableName: tableName,
          Key: { pk: `PROGRAM#${site.leadProgramId}`, sk: `SITE#${siteId}` },
        },
      });
    }
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      ) {
        return jsonResponse(409, { error: "site_reassignment_conflict" });
      }
      throw error;
    }
    return jsonResponse(200, {
      site: {
        ...site,
        providerId,
        providerName: provider.name,
        leadProgramId,
        programName: program.name,
        updatedAt: now,
      },
    });
  });

const COMPLIANCE_LETTER_CONTENT_TYPE = "application/pdf";
const MAX_COMPLIANCE_LETTER_BYTES = 10 * 1024 * 1024;

/**
 * POST /admin/v1/sites/{siteId}/compliance-letters:presign
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const presignComplianceLetter = (event) =>
  adminOnly(event, async (body) => {
    const siteId = event.pathParameters?.siteId ?? "";
    const contentType = String(body.contentType ?? "").toLowerCase();
    const size = Number(body.size);
    if (contentType !== COMPLIANCE_LETTER_CONTENT_TYPE) {
      return jsonResponse(400, { error: "pdf_required" });
    }
    if (
      !Number.isInteger(size) ||
      size < 1 ||
      size > MAX_COMPLIANCE_LETTER_BYTES
    ) {
      return jsonResponse(400, { error: "invalid_file_size" });
    }
    const site = await ddb.send(
      new GetCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `SITE#${siteId}`, sk: "#META" },
      }),
    );
    if (!site.Item || site.Item.status === "inactive") {
      return jsonResponse(404, { error: "site_not_found" });
    }
    const s3Key = `compliance-letters/${siteId}/${randomUUID()}.pdf`;
    const uploadUrl = await presignPut({
      bucket: getConfig().uploadBucket,
      key: s3Key,
      contentType: COMPLIANCE_LETTER_CONTENT_TYPE,
      tagging: "state=pending",
      expiresIn: 300,
    });
    return jsonResponse(200, {
      s3Key,
      uploadUrl,
      expiresIn: 300,
    });
  });

/**
 * PATCH /admin/v1/sites/{siteId}
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const updateSite = (event) =>
  adminOnly(event, async (body) => {
    const siteId = event.pathParameters?.siteId ?? "";
    const name = String(body.name ?? "").trim();
    if (!name) return jsonResponse(400, { error: "name_required" });
    const now = new Date().toISOString();
    const tableName = getDynamoTableName();
    const siteRes = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `SITE#${siteId}`, sk: "#META" },
      }),
    );
    const site = /** @type {any} */ (siteRes.Item);
    if (!site?.siteId) return jsonResponse(404, { error: "not_found" });

    const addressParts =
      body.addressParts === undefined
        ? null
        : normalizeAddressParts(body.addressParts);
    if (body.addressParts !== undefined && !addressParts) {
      return jsonResponse(400, { error: "invalid_address" });
    }
    const address = addressParts
      ? formatAddressParts(addressParts)
      : normalizeAddress(
          body.address === undefined ? site.address : body.address,
        );
    if (
      (body.addressParts !== undefined || body.address !== undefined) &&
      !address
    ) {
      return jsonResponse(400, { error: "address_required" });
    }

    const contactPerson =
      body.contactPerson === undefined
        ? null
        : normalizeContactPerson(body.contactPerson);
    if (body.contactPerson !== undefined && !contactPerson) {
      return jsonResponse(400, { error: "invalid_contact_person" });
    }
    const publicContact =
      body.publicContact === undefined
        ? null
        : normalizePublicContact(body.publicContact);
    if (body.publicContact !== undefined && !publicContact) {
      return jsonResponse(400, { error: "invalid_public_contact" });
    }
    const primaryContactUserId =
      body.primaryContactUserId === undefined
        ? undefined
        : String(body.primaryContactUserId || "").trim();
    /** @type {Record<string, unknown> | undefined} */
    let selectedPrimaryContact;
    if (primaryContactUserId) {
      const assigned = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: {
            pk: `SITE#${siteId}`,
            sk: `ASSIGNED_USER#${primaryContactUserId}`,
          },
        }),
      );
      if (!assigned.Item || assigned.Item.programId !== site.leadProgramId) {
        return jsonResponse(400, { error: "invalid_internal_site_contact" });
      }
      selectedPrimaryContact = assigned.Item;
    }
    const oversight =
      body.oversight === undefined ? null : normalizeOversight(body.oversight);
    if (body.oversight !== undefined && !oversight) {
      return jsonResponse(400, { error: "invalid_oversight" });
    }
    const compliance =
      body.compliance === undefined
        ? null
        : normalizeCompliance(body.compliance);
    if (body.compliance !== undefined && !compliance) {
      return jsonResponse(400, { error: "invalid_compliance" });
    }
    const siteType =
      body.siteType === undefined
        ? undefined
        : normalizeSiteType(body.siteType);
    if (body.siteType !== undefined && body.siteType !== "" && !siteType) {
      return jsonResponse(400, { error: "invalid_site_type" });
    }
    const perimeter =
      body.perimeter === undefined ? null : cleanLongText(body.perimeter);
    if (body.perimeter !== undefined && perimeter === null) {
      return jsonResponse(400, { error: "invalid_perimeter" });
    }
    const complianceLetters =
      body.complianceLetter === undefined
        ? null
        : supersedeComplianceLetter(
            siteId,
            site.complianceLetters,
            body.complianceLetter,
          );
    if (body.complianceLetter !== undefined && !complianceLetters) {
      return jsonResponse(400, { error: "invalid_compliance_letter" });
    }
    const currentLetterKey = site.complianceLetters?.current?.s3Key;
    const nextLetterKey = complianceLetters?.current?.s3Key;
    const uploadedLetterKey =
      nextLetterKey && nextLetterKey !== currentLetterKey
        ? String(nextLetterKey)
        : null;
    let geocoded = null;
    if (address) {
      const existingLocation = locationFromSite(site);
      geocoded =
        address !== site.address || existingLocation instanceof GeocodingError
          ? await geocodeSiteAddress(address)
          : existingLocation;
      if (geocoded instanceof GeocodingError) {
        if (uploadedLetterKey) {
          await deleteComplianceLetterUpload(uploadedLetterKey);
        }
        return jsonResponse(422, { error: geocoded.code });
      }
    }
    if (uploadedLetterKey) {
      const validUpload =
        await validateComplianceLetterUpload(uploadedLetterKey);
      if (!validUpload) {
        await deleteComplianceLetterUpload(uploadedLetterKey);
        return jsonResponse(400, { error: "invalid_compliance_letter" });
      }
      await setObjectTags({
        bucket: getConfig().uploadBucket,
        key: uploadedLetterKey,
        tags: { state: "active" },
      });
    }

    const nextSite = {
      ...site,
      name,
      ...(address ? { address } : {}),
      ...(addressParts ? { addressParts } : {}),
      ...(contactPerson ? { contactPerson } : {}),
      ...(publicContact ? { publicContact } : {}),
      ...(primaryContactUserId !== undefined
        ? { primaryContactUserId: primaryContactUserId || undefined }
        : {}),
      ...(oversight ? { oversight } : {}),
      ...(compliance ? { compliance } : {}),
      ...(siteType !== undefined ? { siteType: siteType || undefined } : {}),
      ...(perimeter !== null ? { perimeter } : {}),
      ...(complianceLetters ? { complianceLetters } : {}),
      ...(geocoded
        ? {
            location: {
              latitude: geocoded.latitude,
              longitude: geocoded.longitude,
            },
            geocodedAddress: geocoded.matchedAddress,
          }
        : {}),
      updatedAt: now,
    };
    const setExpressions = ["#name = :name", "updatedAt = :now"];
    const removeExpressions = [];
    /** @type {Record<string, unknown>} */
    const expressionAttributeValues = {
      ":name": name,
      ":now": now,
    };
    if (address && geocoded) {
      setExpressions.push(
        "address = :address",
        "#location = :location",
        "geocodedAddress = :geocodedAddress",
      );
      expressionAttributeValues[":address"] = address;
      expressionAttributeValues[":location"] = {
        latitude: geocoded.latitude,
        longitude: geocoded.longitude,
      };
      expressionAttributeValues[":geocodedAddress"] = geocoded.matchedAddress;
    }
    if (addressParts) {
      setExpressions.push("addressParts = :addressParts");
      expressionAttributeValues[":addressParts"] = addressParts;
    }
    if (contactPerson) {
      setExpressions.push("contactPerson = :contactPerson");
      expressionAttributeValues[":contactPerson"] = contactPerson;
    }
    if (publicContact) {
      setExpressions.push("publicContact = :publicContact");
      expressionAttributeValues[":publicContact"] = publicContact;
    }
    if (primaryContactUserId !== undefined) {
      if (primaryContactUserId) {
        setExpressions.push(
          "primaryContactUserId = :primaryContactUserId",
          "primaryContact = :primaryContact",
        );
        expressionAttributeValues[":primaryContactUserId"] =
          primaryContactUserId;
        expressionAttributeValues[":primaryContact"] = {
          firstName: selectedPrimaryContact?.firstName || "",
          lastName: selectedPrimaryContact?.lastName || "",
          email: selectedPrimaryContact?.email || "",
          phone: selectedPrimaryContact?.phone || "",
        };
      } else {
        removeExpressions.push("primaryContactUserId", "primaryContact");
      }
    }
    if (oversight) {
      setExpressions.push("oversight = :oversight");
      expressionAttributeValues[":oversight"] = oversight;
    }
    if (compliance) {
      setExpressions.push("compliance = :compliance");
      expressionAttributeValues[":compliance"] = compliance;
    }
    if (siteType !== undefined) {
      if (siteType) {
        setExpressions.push("siteType = :siteType");
        expressionAttributeValues[":siteType"] = siteType;
      } else {
        removeExpressions.push("siteType");
      }
    }
    if (perimeter !== null) {
      setExpressions.push("perimeter = :perimeter");
      expressionAttributeValues[":perimeter"] = perimeter;
    }
    if (complianceLetters) {
      setExpressions.push("complianceLetters = :complianceLetters");
      expressionAttributeValues[":complianceLetters"] = complianceLetters;
    }
    /** @type {import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]} */
    const transactItems = [
      {
        Update: {
          TableName: tableName,
          Key: { pk: `SITE#${siteId}`, sk: "#META" },
          UpdateExpression: `SET ${setExpressions.join(", ")}${removeExpressions.length ? ` REMOVE ${removeExpressions.join(", ")}` : ""}`,
          ConditionExpression: site.updatedAt
            ? "attribute_exists(pk) AND updatedAt = :expectedUpdatedAt"
            : "attribute_exists(pk) AND attribute_not_exists(updatedAt)",
          ExpressionAttributeNames: {
            "#name": "name",
            ...(geocoded ? { "#location": "location" } : {}),
          },
          ExpressionAttributeValues: expressionAttributeValues,
        },
      },
    ];
    if (site.providerId) {
      transactItems.push({
        Update: {
          TableName: tableName,
          Key: { pk: `PROVIDER#${site.providerId}`, sk: `SITE#${siteId}` },
          UpdateExpression: "SET siteName = :name, updatedAt = :now",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: { ":name": name, ":now": now },
        },
      });
    }
    if (site.status !== "inactive") {
      const oldSearchSk = siteSearchSk(site.name, siteId);
      const nextSearchSk = siteSearchSk(name, siteId);
      if (oldSearchSk !== nextSearchSk) {
        transactItems.push({
          Delete: {
            TableName: tableName,
            Key: { pk: "SITE_SEARCH#ACTIVE", sk: oldSearchSk },
          },
        });
      }
      transactItems.push({
        Put: {
          TableName: tableName,
          Item: siteSearchItem(
            siteId,
            name,
            site.providerId,
            site.providerName,
            site.providerSiteId,
            now,
          ),
        },
      });
    }
    if (site.updatedAt) {
      expressionAttributeValues[":expectedUpdatedAt"] = site.updatedAt;
    }
    try {
      await ddb.send(
        new TransactWriteCommand({ TransactItems: transactItems }),
      );
    } catch (error) {
      if (uploadedLetterKey) {
        await deleteComplianceLetterUpload(uploadedLetterKey);
      }
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      ) {
        return jsonResponse(409, { error: "site_update_conflict" });
      }
      throw error;
    }
    return jsonResponse(200, { site: nextSite });
  });

/**
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function validateComplianceLetterUpload(key) {
  try {
    const object = await headObject({
      bucket: getConfig().uploadBucket,
      key,
    });
    return (
      object.contentType === COMPLIANCE_LETTER_CONTENT_TYPE &&
      Number.isInteger(object.contentLength) &&
      Number(object.contentLength) > 0 &&
      Number(object.contentLength) <= MAX_COMPLIANCE_LETTER_BYTES
    );
  } catch {
    return false;
  }
}

/**
 * @param {string} key
 * @returns {Promise<void>}
 */
async function deleteComplianceLetterUpload(key) {
  try {
    await deleteObject({ bucket: getConfig().uploadBucket, key });
  } catch (error) {
    console.error("Failed to clean up compliance-letter upload", {
      key,
      error,
    });
  }
}

/**
 * DELETE /admin/v1/sites/{siteId}
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const deactivateSite = (event) =>
  supervisorOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const now = new Date().toISOString();
    const tableName = getDynamoTableName();
    const siteRes = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `SITE#${siteId}`, sk: "#META" },
      }),
    );
    const site = /** @type {any} */ (siteRes.Item);
    if (!site?.siteId) return jsonResponse(404, { error: "not_found" });

    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk: `SITE#${siteId}`, sk: "#META" },
              UpdateExpression: "SET #status = :inactive, updatedAt = :now",
              ConditionExpression: "attribute_exists(pk)",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":inactive": "inactive",
                ":now": now,
              },
            },
          },
          ...(site.providerId
            ? [
                {
                  Update: {
                    TableName: tableName,
                    Key: {
                      pk: `PROVIDER#${site.providerId}`,
                      sk: `SITE#${siteId}`,
                    },
                    UpdateExpression:
                      "SET #status = :inactive, updatedAt = :now",
                    ConditionExpression: "attribute_exists(pk)",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: {
                      ":inactive": "inactive",
                      ":now": now,
                    },
                  },
                },
              ]
            : []),
          ...(site.leadProgramId
            ? [
                {
                  Delete: {
                    TableName: tableName,
                    Key: {
                      pk: `PROGRAM#${site.leadProgramId}`,
                      sk: `SITE#${siteId}`,
                    },
                  },
                },
              ]
            : []),
          {
            Delete: {
              TableName: tableName,
              Key: {
                pk: "SITE_SEARCH#ACTIVE",
                sk: siteSearchSk(site.name, siteId),
              },
            },
          },
        ],
      }),
    );
    await cleanupDeactivatedSite(siteId, "site_deactivated", now);
    return jsonResponse(200, {
      site: {
        ...site,
        status: "inactive",
        updatedAt: now,
      },
    });
  });

/**
 * POST /admin/v1/sites/{siteId}/setup-codes
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const issueAdminSetupCode = (event) =>
  adminOnly(event, async (body) => {
    const siteId = event.pathParameters?.siteId ?? "";
    const email = normalizeEmail(String(body.email ?? ""));
    const accessLevel = body.accessLevel === "manager" ? "manager" : "general";
    if (!email) return jsonResponse(400, { error: "email_required" });
    const siteRes = await ddb.send(
      new GetCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `SITE#${siteId}`, sk: "#META" },
      }),
    );
    const site = /** @type {any} */ (siteRes.Item);
    if (!site?.siteId || site.status === "inactive") {
      return jsonResponse(404, { error: "site_not_found" });
    }
    const issued = await issueSetupCode({
      siteId,
      siteName: site.name,
      providerId: site.providerId,
      providerName: site.providerName,
      providerSiteId: site.providerSiteId,
      issuedTo: email,
      issuedBy: "central-admin",
      accessLevel,
    });
    return jsonResponse(201, {
      setupCode: {
        code: issued.code,
        expiresAt: issued.item.expiresAt,
        maxUses: issued.item.maxUses,
        uses: issued.item.uses,
        siteId,
        siteName: issued.item.siteName,
        issuedTo: issued.item.issuedTo,
        accessLevel: issued.item.accessLevel,
      },
    });
  });

/**
 * GET /admin/v1/sites/{siteId}/devices
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const listDevices = (event) =>
  adminOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const [bindings, legacyDevices] = await Promise.all([
      queryAll({
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :binding)",
        ExpressionAttributeValues: {
          ":pk": `SITE#${siteId}`,
          ":binding": "DEVICE_BINDING#",
        },
      }),
      queryAll({
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :device)",
        ExpressionAttributeValues: {
          ":pk": `SITE#${siteId}`,
          ":device": "DEVICE#",
        },
      }),
    ]);
    const canonicalIds = new Set(bindings.map((item) => item.bindingId));
    return jsonResponse(200, {
      devices: [
        ...bindings.map((item) => publicDevice(item)),
        ...legacyDevices
          .filter((item) => !canonicalIds.has(item.bindingId ?? item.deviceId))
          .map((item) => publicDevice({ ...item, legacy: true })),
      ],
    });
  });

/**
 * DELETE /admin/v1/sites/{siteId}/devices/{deviceId}
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const revokeDevice = (event) =>
  adminOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const deviceId = event.pathParameters?.deviceId ?? "";
    const tableName = getDynamoTableName();
    const bindingResult = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `SITE#${siteId}`, sk: `DEVICE_BINDING#${deviceId}` },
        ConsistentRead: true,
      }),
    );
    const binding = bindingResult.Item;
    if (!binding) {
      return revokeLegacyDevice(tableName, siteId, deviceId);
    }
    if (binding.status === "revoked") {
      return jsonResponse(200, {
        device: publicDevice(binding),
        alreadyRevoked: true,
      });
    }
    const now = new Date().toISOString();
    const actor = String(
      /** @type {any} */ (event.requestContext)?.authorizer?.jwt?.claims?.sub ??
        "central-admin",
    );
    const nextGeneration = Number(binding.tokenGeneration ?? 0) + 1;
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            revokeBindingUpdate(
              tableName,
              binding.pk,
              binding.sk,
              nextGeneration,
              now,
              actor,
            ),
            revokeBindingUpdate(
              tableName,
              `SITE#${siteId}`,
              `DEVICE#${deviceId}`,
              nextGeneration,
              now,
              actor,
            ),
            {
              Update: {
                TableName: tableName,
                Key: {
                  pk: `PHYSICAL_DEVICE#${binding.physicalDeviceId}`,
                  sk: `BINDING#${deviceId}`,
                },
                UpdateExpression:
                  "SET #status = :revoked, revokedAt = :now, updatedAt = :now",
                ConditionExpression: "attribute_exists(pk)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":revoked": "revoked",
                  ":now": now,
                },
              },
            },
            transactionPut(tableName, {
              pk: `SITE#${siteId}`,
              sk: `AUDIT#${now}#${randomUUID()}`,
              type: "siteAuditEvent",
              eventType: "device_binding_revoked",
              siteId,
              bindingId: deviceId,
              physicalDeviceId: binding.physicalDeviceId,
              accessLevel: binding.accessLevel,
              reason: "city_admin_revocation",
              actor,
              createdAt: now,
            }),
          ],
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      ) {
        return jsonResponse(409, { error: "device_revocation_conflict" });
      }
      throw error;
    }
    return jsonResponse(200, {
      device: publicDevice({
        ...binding,
        status: "revoked",
        tokenGeneration: nextGeneration,
        revokedAt: now,
        revokedBy: actor,
        revokedReason: "city_admin_revocation",
      }),
    });
  });

/** @param {string} tableName @param {string} siteId @param {string} deviceId */
async function revokeLegacyDevice(tableName, siteId, deviceId) {
  const now = new Date().toISOString();
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: `SITE#${siteId}`, sk: `DEVICE#${deviceId}` },
        UpdateExpression:
          "SET #status = :revoked, revokedAt = :now, updatedAt = :now, revokedReason = :reason, tokenGeneration = if_not_exists(tokenGeneration, :zero) + :one",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":revoked": "revoked",
          ":reason": "city_admin_revocation",
          ":now": now,
          ":zero": 0,
          ":one": 1,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return jsonResponse(200, {
      device: publicDevice({ ...res.Attributes, legacy: true }),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    ) {
      return jsonResponse(404, { error: "device_not_found" });
    }
    throw error;
  }
}

/** @param {unknown} value */
function normalizeAddressParts(value) {
  if (!value || typeof value !== "object") return null;
  const input = /** @type {Record<string, unknown>} */ (value);
  const parts = {
    streetNumber: cleanText(input.streetNumber),
    streetAddress: cleanText(input.streetAddress),
    secondLine: cleanText(input.secondLine),
    city: cleanText(input.city),
    state: cleanText(input.state).toUpperCase(),
    zip: cleanText(input.zip),
  };
  if (
    !parts.streetNumber ||
    !parts.streetAddress ||
    !parts.city ||
    !/^[A-Z]{2}$/.test(parts.state) ||
    !/^\d{5}(?:-\d{4})?$/.test(parts.zip)
  ) {
    return null;
  }
  return parts;
}

/** @param {Record<string, string>} parts */
function formatAddressParts(parts) {
  return [
    `${parts.streetNumber} ${parts.streetAddress}`,
    parts.secondLine,
    `${parts.city}, ${parts.state} ${parts.zip}`,
  ]
    .filter(Boolean)
    .join(", ");
}

/** @param {unknown} value */
function normalizeContactPerson(value) {
  if (!value || typeof value !== "object") return null;
  const input = /** @type {Record<string, unknown>} */ (value);
  const firstName = cleanText(input.firstName);
  const lastName = cleanText(input.lastName);
  const email = cleanText(input.email).toLowerCase();
  const phoneDigits = cleanText(input.phone).replace(/\D/g, "");
  const nationalPhone =
    phoneDigits.length === 11 && phoneDigits.startsWith("1")
      ? phoneDigits.slice(1)
      : phoneDigits;
  if (
    !firstName ||
    !lastName ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    nationalPhone.length !== 10
  ) {
    return null;
  }
  return {
    firstName,
    lastName,
    email,
    phone: `${nationalPhone.slice(0, 3)}-${nationalPhone.slice(3, 6)}-${nationalPhone.slice(6)}`,
  };
}

/** @param {unknown} value */
function normalizePublicContact(value) {
  if (!value || typeof value !== "object") return null;
  const input = /** @type {Record<string, unknown>} */ (value);
  const email = cleanText(input.email).toLowerCase();
  const phoneDigits = cleanText(input.phone).replace(/\D/g, "");
  const nationalPhone =
    phoneDigits.length === 11 && phoneDigits.startsWith("1")
      ? phoneDigits.slice(1)
      : phoneDigits;
  if (
    (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
    (cleanText(input.phone) && nationalPhone.length !== 10)
  )
    return null;
  return {
    email,
    phone: nationalPhone
      ? `${nationalPhone.slice(0, 3)}-${nationalPhone.slice(3, 6)}-${nationalPhone.slice(6)}`
      : "",
  };
}

/** @param {unknown} value */
function normalizeOversight(value) {
  if (!value || typeof value !== "object") return null;
  const input = /** @type {Record<string, unknown>} */ (value);
  const managingCityDepartment = cleanText(input.managingCityDepartment);
  return {
    managingCityDepartment,
    managingSystemOfCare: cleanText(input.managingSystemOfCare),
    ...(cleanText(input.cityProgramManagerId)
      ? { cityProgramManagerId: cleanText(input.cityProgramManagerId) }
      : {}),
    cityProgramManager:
      cleanText(input.cityProgramManager) ||
      [
        cleanText(input.cityProgramManagerFirstName),
        cleanText(input.cityProgramManagerLastName),
      ]
        .filter(Boolean)
        .join(" "),
  };
}

/** @param {unknown} value */
function normalizeCompliance(value) {
  if (!value || typeof value !== "object") return null;
  const input = /** @type {Record<string, unknown>} */ (value);
  const currentTier = Number(input.currentTier);
  const periodStart = cleanText(input.periodStart);
  const periodEnd = cleanText(input.periodEnd);
  const requiredChecksPerDay = Number(input.requiredChecksPerDay);
  if (
    !Number.isInteger(currentTier) ||
    currentTier < 1 ||
    currentTier > 4 ||
    !isIsoDate(periodStart) ||
    (periodEnd && (!isIsoDate(periodEnd) || periodEnd < periodStart)) ||
    !Number.isInteger(requiredChecksPerDay) ||
    requiredChecksPerDay < 0 ||
    requiredChecksPerDay > 100
  ) {
    return null;
  }
  return {
    currentTier,
    periodStart,
    periodEnd,
    requiredChecksPerDay,
  };
}

/**
 * @param {string} siteId
 * @param {unknown} existing
 * @param {unknown} value
 */
function supersedeComplianceLetter(siteId, existing, value) {
  if (!value || typeof value !== "object") return null;
  const input = /** @type {Record<string, unknown>} */ (value);
  const s3Key = cleanText(input.s3Key);
  const effectiveStart = cleanText(input.effectiveStart);
  const fileName = cleanText(input.fileName);
  if (
    !s3Key.startsWith(`compliance-letters/${siteId}/`) ||
    !s3Key.endsWith(".pdf") ||
    !isIsoDate(effectiveStart) ||
    !fileName.toLowerCase().endsWith(".pdf")
  ) {
    return null;
  }
  const letters =
    existing && typeof existing === "object"
      ? /** @type {Record<string, any>} */ (existing)
      : {};
  if (letters.current?.s3Key === s3Key) return letters;
  const past = Array.isArray(letters.past) ? [...letters.past] : [];
  if (letters.current) {
    past.unshift({
      ...letters.current,
      effectiveEnd: previousIsoDate(effectiveStart),
    });
  }
  return {
    current: { s3Key, effectiveStart, fileName },
    past,
  };
}

/** @param {unknown} value */
function cleanText(value) {
  return typeof value === "string" ? value.trim().slice(0, 250) : "";
}

/** @param {Record<string, any>} item */
function publicProgramManager(item) {
  return {
    userId: String(item.userId || ""),
    name:
      cleanText(item.name) ||
      [cleanText(item.firstName), cleanText(item.lastName)]
        .filter(Boolean)
        .join(" "),
    email: cleanText(item.email),
    phone: cleanText(item.phone),
  };
}

/** @param {unknown} value */
function normalizePhone(value) {
  const digits = cleanText(value).replace(/\D/g, "");
  const national =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return national.length === 10
    ? `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`
    : "";
}

/** @param {unknown} value */
function normalizeSiteType(value) {
  const siteType = cleanText(value);
  return ["permanent_supportive_housing", "shelter", "drop_in"].includes(
    siteType,
  )
    ? siteType
    : "";
}

/** @param {unknown} value */
function cleanLongText(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned.length <= 4000 ? cleaned : null;
}

/** @param {string} value */
function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

/** @param {string} value */
function previousIsoDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeAddress(value) {
  const address =
    typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return address.length >= 3 && address.length <= 240 ? address : "";
}

/**
 * @param {string} siteId
 * @param {string} reason
 * @param {string} now
 * @returns {Promise<void>}
 */
function cleanupDeactivatedSite(siteId, reason, now) {
  return Promise.all([
    revokePendingSetupCodesForSite({
      siteId,
      reason,
    }),
    revokeSiteDevices(siteId, now),
    deactivateSiteManagerAssociations(siteId, now),
  ]).then(() => undefined);
}

/**
 * Archive Site-specific manager memberships without changing their Program users.
 * @param {string} siteId
 * @param {string} now
 * @returns {Promise<void>}
 */
async function deactivateSiteManagerAssociations(siteId, now) {
  const memberships = await queryAll({
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :membership)",
    ExpressionAttributeValues: {
      ":pk": `SITE#${siteId}`,
      ":membership": "MANAGER_MEMBERSHIP#",
    },
  });
  await Promise.all(
    memberships
      .filter((membership) => membership.status === "active")
      .map((membership) =>
        ddb.send(
          new UpdateCommand({
            TableName: getDynamoTableName(),
            Key: { pk: membership.pk, sk: membership.sk },
            UpdateExpression:
              "SET #status = :inactive, deactivatedAt = :now, updatedAt = :now, generation = if_not_exists(generation, :zero) + :one",
            ConditionExpression: "attribute_exists(pk)",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":inactive": "inactive",
              ":now": now,
              ":zero": 0,
              ":one": 1,
            },
          }),
        ),
      ),
  );
}

/**
 * @param {string} siteId
 * @param {string} now
 * @returns {Promise<void>}
 */
async function revokeSiteDevices(siteId, now) {
  const devices = await queryAll({
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :device)",
    ExpressionAttributeValues: {
      ":pk": `SITE#${siteId}`,
      ":device": "DEVICE#",
    },
  });

  await Promise.all(
    devices.map((device) =>
      ddb.send(
        new UpdateCommand({
          TableName: getDynamoTableName(),
          Key: { pk: `SITE#${siteId}`, sk: device.sk },
          UpdateExpression:
            "SET #status = :revoked, revokedAt = :now, updatedAt = :now, tokenGeneration = if_not_exists(tokenGeneration, :zero) + :one",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":revoked": "revoked",
            ":now": now,
            ":zero": 0,
            ":one": 1,
          },
        }),
      ),
    ),
  );
}

/**
 * @param {unknown} provided
 * @param {string} fallback
 * @returns {string}
 */
function slug(provided, fallback) {
  const value = String(provided || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return value || randomUUID();
}

/** @param {Record<string, any>} item */
function publicDevice(item) {
  const bindingId = String(item.bindingId ?? item.deviceId ?? "");
  return {
    bindingId,
    deviceId: bindingId,
    physicalDeviceId: item.physicalDeviceId,
    siteId: item.siteId,
    label: item.label,
    accessLevel: item.accessLevel === "admin" ? "manager" : item.accessLevel,
    status: item.status ?? "active",
    enrolledAt: item.enrolledAt ?? item.registeredAt,
    lastSeenAt: item.lastSeenAt,
    absoluteExpiresAt: item.absoluteExpiresAt,
    revokedAt: item.revokedAt,
    revokedReason: item.revokedReason,
    suspendedAt: item.suspendedAt,
    suspendedReason: item.suspendedReason,
    legacy: item.legacy === true,
  };
}

/**
 * @param {string} tableName
 * @param {string} pk
 * @param {string} sk
 * @param {number} nextGeneration
 * @param {string} now
 * @param {string} actor
 */
function revokeBindingUpdate(tableName, pk, sk, nextGeneration, now, actor) {
  return {
    Update: {
      TableName: tableName,
      Key: { pk, sk },
      UpdateExpression:
        "SET #status = :revoked, revokedAt = :now, updatedAt = :now, revokedReason = :reason, revokedBy = :actor, tokenGeneration = :next",
      ConditionExpression:
        "attribute_exists(pk) AND (attribute_not_exists(#status) OR #status <> :revoked)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":revoked": "revoked",
        ":reason": "city_admin_revocation",
        ":actor": actor,
        ":now": now,
        ":next": nextGeneration,
      },
    },
  };
}

/** @param {string} tableName @param {Record<string, unknown>} item */
function transactionPut(tableName, item) {
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression:
        "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    },
  };
}

/**
 * @param {string} providerId
 * @param {string} name
 * @param {string} now
 * @returns {Promise<unknown>}
 */
function putProviderSearch(providerId, name, now) {
  return ddb.send(
    new PutCommand({
      TableName: getDynamoTableName(),
      Item: {
        pk: "PROVIDER_SEARCH#ACTIVE",
        sk: providerId,
        type: "providerSearch",
        providerId,
        name,
        searchText: name.toLowerCase(),
        status: "active",
        updatedAt: now,
      },
    }),
  );
}

/**
 * @param {Omit<import("@aws-sdk/lib-dynamodb").QueryCommandInput, "TableName">} input
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function queryAll(input) {
  /** @type {Record<string, unknown>[]} */
  const items = [];
  /** @type {Record<string, unknown> | undefined} */
  let exclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: getDynamoTableName(),
        ...input,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...(res.Items ?? []));
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}
