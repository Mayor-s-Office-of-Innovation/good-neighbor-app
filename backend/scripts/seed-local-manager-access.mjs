// Repair only active, legacy MOICHL manager devices in the local emulator.
// Existing canonical bindings and revoked/suspended devices are never restored.
import { randomUUID } from "node:crypto";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../src/db.js";
import { emailHash } from "../src/handlers/setup-codes.js";
import { assertLocalSeedTarget } from "./lib/site-admin-seed.mjs";

assertLocalSeedTarget();
const TableName = process.env.DYNAMO_TABLE;
const pk = "SITE#city-hall";
const membershipId = "local-city-hall-manager";
const email = "cityhall@example.org";
const hash = await emailHash(email);
const now = new Date().toISOString();
const { Item: site } = await ddb.send(
  new GetCommand({ TableName, Key: { pk, sk: "#META" }, ConsistentRead: true }),
);
if (site?.status !== "active") throw new Error("Seed City Hall first");
const { Items: devices = [] } = await ddb.send(
  new QueryCommand({
    TableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": pk, ":prefix": "DEVICE#" },
    ConsistentRead: true,
  }),
);
// Repair active membership discovery even when there are no active devices.
// Device revocation does not revoke the person's Site membership.
const directoryWrites = await fixtureIdentityWrites(false);
if (directoryWrites.length)
  await ddb.send(new TransactWriteCommand({ TransactItems: directoryWrites }));
let repaired = 0;
for (const device of devices) {
  if (
    device.accessLevel !== "manager" ||
    (device.status && device.status !== "active")
  )
    continue;
  const bindingId = device.deviceId;
  const { Item: binding } = await ddb.send(
    new GetCommand({
      TableName,
      Key: { pk, sk: `DEVICE_BINDING#${bindingId}` },
      ConsistentRead: true,
    }),
  );
  if (
    binding &&
    (binding.status !== "active" || binding.membershipId !== membershipId)
  )
    continue;
  const physicalDeviceId = device.physicalDeviceId || randomUUID();
  const base = {
    siteId: "city-hall",
    siteName: site.name,
    label: device.label || "Local City Hall manager",
    status: "active",
    accessLevel: "manager",
    bindingId,
    physicalDeviceId,
    membershipId,
    membershipGeneration: 1,
    siteCredentialGeneration: Number(site.siteCredentialGeneration ?? 0),
    enrolledAt: device.registeredAt || now,
    lastSeenAt: device.lastSeenAt || now,
    absoluteExpiresAt:
      device.absoluteExpiresAt ||
      new Date(Date.now() + 365 * 86400000).toISOString(),
    inactivityLimitDays: 60,
  };
  const identityWrites = await fixtureIdentityWrites(true);
  if (binding) {
    if (identityWrites.length)
      await ddb.send(
        new TransactWriteCommand({ TransactItems: identityWrites }),
      );
    continue;
  }
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        ...identityWrites,
        put({
          pk,
          sk: `DEVICE_BINDING#${bindingId}`,
          type: "deviceBinding",
          ...base,
          tokenGeneration: device.tokenGeneration,
        }),
        {
          Update: {
            TableName,
            Key: { pk, sk: device.sk },
            UpdateExpression:
              "SET bindingId = :binding, physicalDeviceId = :physical, membershipId = :member, membershipGeneration = :generation, siteCredentialGeneration = :siteGeneration, #status = :active",
            ConditionExpression:
              "tokenGeneration = :tokenGeneration AND (attribute_not_exists(#status) OR #status = :active)",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":binding": bindingId,
              ":physical": physicalDeviceId,
              ":member": membershipId,
              ":generation": 1,
              ":siteGeneration": base.siteCredentialGeneration,
              ":active": "active",
              ":tokenGeneration": device.tokenGeneration,
            },
          },
        },
        put({
          pk: `PHYSICAL_DEVICE#${physicalDeviceId}`,
          sk: "#META",
          type: "physicalDevice",
          physicalDeviceId,
          status: "active",
          label: device.label || "Local City Hall manager",
          createdAt: now,
        }),
        put({
          pk: `PHYSICAL_DEVICE#${physicalDeviceId}`,
          sk: `BINDING#${bindingId}`,
          type: "physicalDeviceBindingPointer",
          ...base,
        }),
      ],
    }),
  );
  repaired++;
}
console.log(
  `Local City Hall manager access ready (${repaired} legacy device(s) repaired).`,
);

/** @param {boolean} allowCreate */
async function fixtureIdentityWrites(allowCreate) {
  const membership = {
    pk,
    sk: `MANAGER_MEMBERSHIP#${membershipId}`,
    type: "managerMembership",
    siteId: "city-hall",
    membershipId,
    email,
    emailHash: hash,
    role: "manager",
    status: "active",
    generation: 1,
    createdAt: now,
  };
  const { Item: existingMember } = await ddb.send(
    new GetCommand({
      TableName,
      Key: { pk, sk: membership.sk },
      ConsistentRead: true,
    }),
  );
  if (!existingMember && !allowCreate) return [];
  if (
    existingMember &&
    (existingMember.status !== "active" ||
      existingMember.generation !== 1 ||
      existingMember.emailHash !== hash ||
      existingMember.email !== email ||
      existingMember.siteId !== "city-hall" ||
      existingMember.membershipId !== membershipId)
  )
    throw new Error("Local fixture membership changed; refusing to restore it");
  const identityWrites = !existingMember ? [put(membership)] : [];
  for (const pointer of [
    {
      pk,
      sk: `MANAGER_EMAIL#${hash}`,
      type: "managerMembershipEmail",
      membershipId,
      siteId: "city-hall",
      createdAt: now,
    },
    {
      pk: `MANAGER_EMAIL#${hash}`,
      sk: `SITE#city-hall#MEMBERSHIP#${membershipId}`,
      type: "managerMembershipDirectory",
      membershipId,
      siteId: "city-hall",
      status: "active",
      createdAt: now,
    },
  ]) {
    const { Item: existing } = await ddb.send(
      new GetCommand({
        TableName,
        Key: { pk: pointer.pk, sk: pointer.sk },
        ConsistentRead: true,
      }),
    );
    if (
      existing &&
      (existing.membershipId !== membershipId ||
        existing.siteId !== "city-hall" ||
        (existing.status && existing.status !== "active"))
    )
      throw new Error(
        "Local fixture email assignment conflicts; refusing to overwrite it",
      );
    if (!existing) identityWrites.push(put(pointer));
  }
  if (existingMember && identityWrites.length)
    identityWrites.push({
      ConditionCheck: {
        TableName,
        Key: { pk, sk: membership.sk },
        ConditionExpression:
          "#status = :active AND generation = :generation AND emailHash = :hash",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":active": "active",
          ":generation": 1,
          ":hash": hash,
        },
      },
    });
  return identityWrites;
}

function put(Item, condition = "attribute_not_exists(pk)") {
  return { Put: { TableName, Item, ConditionExpression: condition } };
}
