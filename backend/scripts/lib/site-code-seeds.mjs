import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { normalizeExplicitShortCode } from "../../src/lib/short-codes.js";

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
    providerShortCode: "MOI",
    siteId: "city-hall",
    siteName: "City Hall",
    siteShortCode: "CIT",
    providerSiteId: "provider-site-city-hall",
    places: [],
  },
  {
    code: "GUBSJE",
    providerId: "the-gubbio-project",
    providerName: "The Gubbio Project",
    providerShortCode: "GUB",
    siteId: "st-john-the-evangelist",
    siteName: "St. John the Evangelist",
    siteShortCode: "STJ",
    providerSiteId: "provider-site-st-john-the-evangelist",
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
    providerShortCode: "CHC",
    siteId: "chc-730-polk",
    siteName: "730 Polk",
    siteShortCode: "730",
    providerSiteId: "provider-site-chc-730-polk",
    places: [],
  },
  {
    code: "SFA940",
    providerId: "sfaf",
    providerName: "SFAF",
    providerShortCode: "SFA",
    siteId: "sfaf-940-howard",
    siteName: "940 Howard",
    siteShortCode: "940",
    providerSiteId: "provider-site-sfaf-940-howard",
    places: [],
  },
  {
    code: "THC440",
    providerId: "thc",
    providerName: "THC",
    providerShortCode: "THC",
    siteId: "thc-440-eddy",
    siteName: "440 Eddy",
    siteShortCode: "440",
    providerSiteId: "provider-site-thc-440-eddy",
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
    validateSeedShortCodes(seed);
    await putProvider(docDdb, tableName, seed, now);
    await upsertSite(docDdb, tableName, seed, now);
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
 * @param {typeof devSiteCodeSeeds[number]} seed
 */
function validateSeedShortCodes(seed) {
  if (
    normalizeExplicitShortCode(seed.providerShortCode) !==
      seed.providerShortCode ||
    normalizeExplicitShortCode(seed.siteShortCode) !== seed.siteShortCode
  ) {
    throw new Error(`Invalid short code seed for site ${seed.siteId}`);
  }
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
        providerShortCode: seed.providerShortCode,
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
        "SET #type = :type, entityType = :entityType, siteId = :siteId, providerId = :providerId, providerSiteId = :providerSiteId, providerShortCode = :providerShortCode, siteShortCode = :siteShortCode, #name = :name, places = if_not_exists(places, :places), seededAt = if_not_exists(seededAt, :now), updatedAt = :now" +
        (seed.location
          ? ", #location = if_not_exists(#location, :location)"
          : ""),
      ExpressionAttributeNames: {
        "#type": "type",
        "#name": "name",
        ...(seed.location ? { "#location": "location" } : {}),
      },
      ExpressionAttributeValues: {
        ":type": "site",
        ":entityType": "SITE",
        ":siteId": seed.siteId,
        ":providerId": seed.providerId,
        ":providerSiteId": seed.providerSiteId,
        ":providerShortCode": seed.providerShortCode,
        ":siteShortCode": seed.siteShortCode,
        ":name": seed.siteName,
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
        providerShortCode: seed.providerShortCode,
        providerSiteId: seed.providerSiteId,
        siteId: seed.siteId,
        siteName: seed.siteName,
        siteShortCode: seed.siteShortCode,
        seededAt: now,
        updatedAt: now,
      },
    }),
  );
}
