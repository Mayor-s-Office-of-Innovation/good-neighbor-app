import { createHmac } from "node:crypto";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const nowIso = () => new Date().toISOString();

export const stJohnPlaces = [
  { id: "place-15th-st", name: "15th St", order: 0 },
  { id: "place-front-entrance", name: "Front entrance", order: 1 },
  { id: "place-caledonia-st", name: "Caledonia St", order: 2 },
];

export const devSiteCodeSeeds = [
  {
    code: "MOICHL",
    providerId: "moi",
    providerName: "MOI",
    siteId: "city-hall",
    siteName: "City Hall",
    providerSiteId: "provider-site-city-hall",
    contactEmail: "cityhall@example.org",
    places: [],
  },
  {
    code: "GUBSJE",
    providerId: "the-gubbio-project",
    providerName: "The Gubbio Project",
    siteId: "st-john-the-evangelist",
    siteName: "St. John the Evangelist",
    providerSiteId: "provider-site-st-john-the-evangelist",
    contactEmail: "stjohn@example.org",
    location: {
      latitude: 37.76656393517443,
      longitude: -122.4213267021692,
    },
    places: stJohnPlaces,
  },
  {
    code: "CHC730",
    providerId: "chc",
    providerName: "CHC",
    siteId: "chc-730-polk",
    siteName: "730 Polk",
    providerSiteId: "provider-site-chc-730-polk",
    contactEmail: "chc730@example.org",
    places: [],
  },
  {
    code: "SFA940",
    providerId: "sfaf",
    providerName: "SFAF",
    siteId: "sfaf-940-howard",
    siteName: "940 Howard",
    providerSiteId: "provider-site-sfaf-940-howard",
    contactEmail: "sfaf940@example.org",
    places: [],
  },
  {
    code: "THC440",
    providerId: "thc",
    providerName: "THC",
    siteId: "thc-440-eddy",
    siteName: "440 Eddy",
    providerSiteId: "provider-site-thc-440-eddy",
    contactEmail: "thc440@example.org",
    places: [],
  },
];

export const inactiveLocalSiteCodeSeed = {
  pk: "SITE_CODE#000000",
  sk: "#META",
  type: "providerSiteCode",
  code: "000000",
  active: false,
  providerSiteId: "provider-site-inactive",
  siteId: "site-inactive",
  siteName: "Inactive Test Site",
};

/**
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} docDdb
 * @param {string} tableName
 * @param {{ includeInactive?: boolean, includeLegacyLocalCode?: boolean }} [options]
 * @returns {Promise<{ seededCodes: string[] }>}
 */
export async function seedSiteCodes(docDdb, tableName, options = {}) {
  const now = nowIso();
  const seededCodes = [];

  for (const seed of devSiteCodeSeeds) {
    await putProvider(docDdb, tableName, seed, now);
    await putProviderSearch(docDdb, tableName, seed, now);
    await upsertSite(docDdb, tableName, seed, now);
    await putProviderSiteMembership(docDdb, tableName, seed, now);
    await putSiteSearch(docDdb, tableName, seed, now);
    await putCodeContact(docDdb, tableName, seed, now);
    await putMasterContact(docDdb, tableName, seed, now);
    await putDynamicSetupCode(docDdb, tableName, seed, now);
    await putSiteCode(docDdb, tableName, seed, now);
    seededCodes.push(seed.code);
  }

  if (options.includeLegacyLocalCode) {
    const legacySeed = devSiteCodeSeeds.find(
      (seed) => seed.siteId === "st-john-the-evangelist",
    );
    if (legacySeed) {
      await putSiteCode(
        docDdb,
        tableName,
        { ...legacySeed, code: "123456" },
        now,
      );
      seededCodes.push("123456");
    }
  }

  if (options.includeInactive) {
    await docDdb.send(
      new PutCommand({
        TableName: tableName,
        Item: { ...inactiveLocalSiteCodeSeed, seededAt: now },
      }),
    );
    seededCodes.push(inactiveLocalSiteCodeSeed.code);
  }

  return { seededCodes };
}

/**
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} docDdb
 * @param {string} tableName
 * @param {typeof devSiteCodeSeeds[number]} seed
 * @param {string} now
 */
async function putProviderSearch(docDdb, tableName, seed, now) {
  await docDdb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: "PROVIDER_SEARCH#ACTIVE",
        sk: seed.providerId,
        type: "providerSearch",
        providerId: seed.providerId,
        name: seed.providerName,
        searchText: seed.providerName.toLowerCase(),
        status: "active",
        seededAt: now,
        updatedAt: now,
      },
    }),
  );
}

/**
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} docDdb
 * @param {string} tableName
 * @param {typeof devSiteCodeSeeds[number]} seed
 * @param {string} now
 */
async function putProvider(docDdb, tableName, seed, now) {
  await docDdb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: `PROVIDER#${seed.providerId}`,
        sk: "#META",
        entityType: "PROVIDER",
        providerId: seed.providerId,
        name: seed.providerName,
        status: "active",
        seededAt: now,
        updatedAt: now,
      },
    }),
  );
}

/**
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} docDdb
 * @param {string} tableName
 * @param {typeof devSiteCodeSeeds[number]} seed
 * @param {string} now
 */
async function upsertSite(docDdb, tableName, seed, now) {
  await docDdb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk: `SITE#${seed.siteId}`, sk: "#META" },
      UpdateExpression:
        "SET #type = :type, entityType = :entityType, siteId = :siteId, providerId = :providerId, providerName = :providerName, providerSiteId = :providerSiteId, #name = :name, #status = :status, places = if_not_exists(places, :places), seededAt = if_not_exists(seededAt, :now), updatedAt = :now" +
        (seed.location
          ? ", #location = if_not_exists(#location, :location)"
          : ""),
      ExpressionAttributeNames: {
        "#type": "type",
        "#name": "name",
        "#status": "status",
        ...(seed.location ? { "#location": "location" } : {}),
      },
      ExpressionAttributeValues: {
        ":type": "site",
        ":entityType": "SITE",
        ":siteId": seed.siteId,
        ":providerId": seed.providerId,
        ":providerName": seed.providerName,
        ":providerSiteId": seed.providerSiteId,
        ":name": seed.siteName,
        ":status": "active",
        ":places": seed.places,
        ":now": now,
        ...(seed.location ? { ":location": seed.location } : {}),
      },
    }),
  );
}

/**
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} docDdb
 * @param {string} tableName
 * @param {typeof devSiteCodeSeeds[number]} seed
 * @param {string} now
 */
async function putProviderSiteMembership(docDdb, tableName, seed, now) {
  await docDdb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: `PROVIDER#${seed.providerId}`,
        sk: `SITE#${seed.siteId}`,
        type: "providerSiteMembership",
        providerId: seed.providerId,
        providerName: seed.providerName,
        siteId: seed.siteId,
        siteName: seed.siteName,
        providerSiteId: seed.providerSiteId,
        status: "active",
        seededAt: now,
        updatedAt: now,
      },
    }),
  );
}

/**
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} docDdb
 * @param {string} tableName
 * @param {typeof devSiteCodeSeeds[number]} seed
 * @param {string} now
 */
async function putSiteSearch(docDdb, tableName, seed, now) {
  await docDdb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: "SITE_SEARCH#ACTIVE",
        sk: `${seed.siteName.toLowerCase()}#${seed.siteId}`,
        type: "siteSearch",
        siteId: seed.siteId,
        siteName: seed.siteName,
        providerId: seed.providerId,
        providerName: seed.providerName,
        providerSiteId: seed.providerSiteId,
        label: `${seed.siteName} (${seed.providerName})`,
        searchText: `${seed.siteName} ${seed.providerName}`.toLowerCase(),
        status: "active",
        seededAt: now,
        updatedAt: now,
      },
    }),
  );
}

/**
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} docDdb
 * @param {string} tableName
 * @param {typeof devSiteCodeSeeds[number]} seed
 * @param {string} now
 */
async function putCodeContact(docDdb, tableName, seed, now) {
  const email = seed.contactEmail.toLowerCase();
  const contactHash = hashEmail(email);
  await docDdb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: `SITE#${seed.siteId}`,
        sk: `CODE_CONTACT#${contactHash}`,
        type: "codeContact",
        email,
        emailHash: contactHash,
        siteId: seed.siteId,
        siteName: seed.siteName,
        status: "active",
        seededAt: now,
        updatedAt: now,
      },
    }),
  );
}

/**
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} docDdb
 * @param {string} tableName
 * @param {typeof devSiteCodeSeeds[number]} seed
 * @param {string} now
 */
async function putMasterContact(docDdb, tableName, seed, now) {
  const email = seed.contactEmail.toLowerCase();
  const contactHash = hashEmail(email);
  await docDdb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: `SITE#${seed.siteId}`,
        sk: `MASTER_CONTACT#${contactHash}`,
        type: "masterContact",
        email,
        emailHash: contactHash,
        siteId: seed.siteId,
        siteName: seed.siteName,
        status: "active",
        seededAt: now,
        updatedAt: now,
      },
    }),
  );
}

/**
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} docDdb
 * @param {string} tableName
 * @param {typeof devSiteCodeSeeds[number]} seed
 * @param {string} now
 */
async function putDynamicSetupCode(docDdb, tableName, seed, now) {
  const verifier = hashCode(seed.code);
  try {
    await docDdb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: `SETUP_CODE#${verifier}`,
          sk: "#META",
          type: "setupCode",
          codeId: `seed-${seed.siteId}`,
          codeVerifier: verifier,
          status: "pending",
          expiresAt: "2999-01-01T00:00:00.000Z",
          maxUses: 3,
          uses: 0,
          siteId: seed.siteId,
          siteName: seed.siteName,
          providerId: seed.providerId,
          providerName: seed.providerName,
          providerSiteId: seed.providerSiteId,
          issuedTo: seed.contactEmail.toLowerCase(),
          issuedBy: "local-seed",
          createdAt: now,
        updatedAt: now,
        gsi6pk: `SETUP_CODE_PENDING#${seed.siteId}#${hashEmail(seed.contactEmail)}`,
        gsi6sk: now,
        gsi7pk: `SETUP_CODE_PENDING_SITE#${seed.siteId}`,
        gsi7sk: now,
      },
      ConditionExpression: "attribute_not_exists(pk)",
    }),
    );
  } catch (err) {
    if (/** @type {Error} */ (err).name !== "ConditionalCheckFailedException") {
      throw err;
    }
  }
}

/**
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} docDdb
 * @param {string} tableName
 * @param {typeof devSiteCodeSeeds[number]} seed
 * @param {string} now
 */
async function putSiteCode(docDdb, tableName, seed, now) {
  await docDdb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: `SITE_CODE#${seed.code}`,
        sk: "#META",
        type: "providerSiteCode",
        code: seed.code,
        active: true,
        providerId: seed.providerId,
        providerName: seed.providerName,
        providerSiteId: seed.providerSiteId,
        siteId: seed.siteId,
        siteName: seed.siteName,
        seededAt: now,
        updatedAt: now,
      },
    }),
  );
}

/**
 * @param {string} value
 * @returns {string}
 */
function hashCode(value) {
  return createHmac("sha256", verifierSecret())
    .update(value.trim().toUpperCase())
    .digest("hex");
}

/**
 * @param {string} value
 * @returns {string}
 */
function hashEmail(value) {
  return createHmac("sha256", verifierSecret())
    .update(value.trim().toLowerCase())
    .digest("hex");
}

/**
 * @returns {string}
 */
function verifierSecret() {
  return (
    process.env.SETUP_CODE_VERIFIER_SECRET ||
    process.env.DEVICE_TOKEN_SECRET ||
    "local-dev-setup-code-verifier-secret"
  );
}
