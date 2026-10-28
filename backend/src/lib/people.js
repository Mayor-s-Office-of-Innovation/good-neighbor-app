import { randomUUID, createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getDynamoTableName } from "../config.js";
import { emailHash } from "../handlers/setup-codes.js";

/** @param {string} personId */
export const personKey = (personId) => ({
  pk: "PEOPLE",
  sk: `PERSON#${personId}`,
});
/** @param {string | undefined} personId @returns {Promise<Record<string, any> | null>} */
export async function getPerson(personId) {
  if (!personId) return null;
  return (
    (
      await ddb.send(
        new GetCommand({
          TableName: getDynamoTableName(),
          Key: personKey(personId),
          ConsistentRead: true,
        }),
      )
    ).Item || null
  );
}
/** @param {Record<string, any>} contact @param {string} [personId] @param {Array<{pk:string,sk:string}>} [sources] @returns {Record<string, any>} */
export function personRecord(contact, personId = randomUUID(), sources = []) {
  return {
    ...personKey(personId),
    type: "person",
    personId,
    firstName: String(contact.firstName || ""),
    lastName: String(contact.lastName || ""),
    name: `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
    email: String(contact.email || "")
      .trim()
      .toLowerCase(),
    phone: String(contact.phone || ""),
    phoneExtension: String(contact.phoneExtension || ""),
    primaryProviderId: String(contact.primaryProviderId || ""),
    primaryProgramId: String(contact.primaryProgramId || ""),
    siteManager: contact.siteManager === true,
    sources,
    status: "active",
    revision: randomUUID(),
    createdAt: new Date().toISOString(),
  };
}
/** @param {Record<string, any>} person @param {string} [expectedRevision] @returns {NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]>[number]} */
export function personPut(person, expectedRevision) {
  return {
    Put: {
      TableName: getDynamoTableName(),
      Item: person,
      ConditionExpression: expectedRevision
        ? "revision = :revision"
        : "attribute_not_exists(pk)",
      ...(expectedRevision
        ? { ExpressionAttributeValues: { ":revision": expectedRevision } }
        : {}),
    },
  };
}
/** Contact changes are atomic across the person and compatibility records. No access generations change. */
/** @param {Record<string, any>} person @param {Record<string, any>} input @param {string} actor @param {Array<NonNullable<NonNullable<import('@aws-sdk/lib-dynamodb').TransactWriteCommandInput['TransactItems']>[number]['ConditionCheck']>>} [guards] */
export async function updatePersonRecord(person, input, actor, guards = []) {
  const contact = {
    firstName: String(input.firstName || "").trim(),
    lastName: String(input.lastName || "").trim(),
    email: String(input.email || "")
      .trim()
      .toLowerCase(),
    phone: String(input.phone || "").trim(),
    phoneExtension: String(input.phoneExtension || "").trim(),
  };
  if (
    !contact.firstName ||
    !contact.lastName ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email) ||
    contact.firstName.length > 100 ||
    contact.lastName.length > 100 ||
    contact.email.length > 320 ||
    contact.phone.length > 40 ||
    contact.phoneExtension.length > 20
  )
    throw new Error("invalid_person_contact");
  const next = {
    ...person,
    ...contact,
    name: `${contact.firstName} ${contact.lastName}`,
    primaryProviderId:
      input.primaryProviderId === undefined
        ? person.primaryProviderId
        : String(input.primaryProviderId),
    primaryProgramId:
      input.primaryProgramId === undefined
        ? person.primaryProgramId
        : String(input.primaryProgramId),
    revision: randomUUID(),
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  };
  const affiliationChecks = [];
  for (const [id, prefix] of [
    [next.primaryProviderId, "PROVIDER"],
    [next.primaryProgramId, "PROGRAM"],
  ]) {
    if (!id) continue;
    const { Item } = await ddb.send(
      new GetCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `${prefix}#${id}`, sk: "#META" },
        ConsistentRead: true,
      }),
    );
    if (!Item || Item.status === "inactive")
      throw new Error("affiliation_not_found");
    affiliationChecks.push({
      ConditionCheck: {
        TableName: getDynamoTableName(),
        Key: { pk: `${prefix}#${id}`, sk: "#META" },
        ConditionExpression: "#status = :active",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":active": "active" },
      },
    });
  }
  /** @type {import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]} */
  const writes = [personPut(next, person.revision), ...affiliationChecks];
  for (const source of person.sources || []) {
    const { Item: row } = await ddb.send(
      new GetCommand({
        TableName: getDynamoTableName(),
        Key: { pk: source.pk, sk: source.sk },
        ConsistentRead: true,
      }),
    );
    if (!row) continue;
    if (row.personId !== person.personId)
      throw new Error("person_source_conflict");
    /** @type {Record<string, any>} */
    const updated = {
      ...row,
      ...contact,
      name: next.name,
      updatedAt: next.updatedAt,
    };
    if (row.emailHash) updated.emailHash = await emailHash(contact.email);
    writes.push({
      Put: {
        TableName: getDynamoTableName(),
        Item: updated,
        ConditionExpression: `personId = :person AND ${row.updatedAt ? "updatedAt = :updated" : "attribute_not_exists(updatedAt)"}`,
        ExpressionAttributeValues: {
          ":person": person.personId,
          ...(row.updatedAt ? { ":updated": row.updatedAt } : {}),
        },
      },
    });
    if (
      row.status !== "inactive" &&
      row.email !== contact.email &&
      row.sk.startsWith("PROVIDER_MANAGER#")
    ) {
      const hash = (/** @type {string} */ email) =>
        createHash("sha256")
          .update(email.trim().toLowerCase())
          .digest("hex")
          .slice(0, 24);
      const sk = `PROVIDER#${row.providerId}#MEMBERSHIP#${row.membershipId}`;
      writes.push(
        {
          Delete: {
            TableName: getDynamoTableName(),
            Key: { pk: `PROVIDER_MANAGER_EMAIL#${hash(row.email)}`, sk },
          },
        },
        {
          Put: {
            TableName: getDynamoTableName(),
            Item: {
              pk: `PROVIDER_MANAGER_EMAIL#${hash(contact.email)}`,
              sk,
              providerId: row.providerId,
              membershipId: row.membershipId,
              status: "active",
              createdAt: next.updatedAt,
            },
          },
        },
      );
    }
    if (
      row.status !== "inactive" &&
      row.emailHash &&
      updated.emailHash !== row.emailHash &&
      row.sk.startsWith("MANAGER_MEMBERSHIP#")
    ) {
      const directorySk = `SITE#${row.siteId}#MEMBERSHIP#${row.membershipId}`;
      for (const key of [
        { pk: `SITE#${row.siteId}`, sk: `MANAGER_EMAIL#${row.emailHash}` },
        { pk: `MANAGER_EMAIL#${row.emailHash}`, sk: directorySk },
      ])
        writes.push({ Delete: { TableName: getDynamoTableName(), Key: key } });
      for (const key of [
        { pk: `SITE#${row.siteId}`, sk: `MANAGER_EMAIL#${updated.emailHash}` },
        { pk: `MANAGER_EMAIL#${updated.emailHash}`, sk: directorySk },
      ])
        writes.push({
          Put: {
            TableName: getDynamoTableName(),
            Item: {
              ...key,
              membershipId: row.membershipId,
              siteId: row.siteId,
              status: "active",
              createdAt: next.updatedAt,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        });
    }
  }
  writes.push({
    Put: {
      TableName: getDynamoTableName(),
      Item: {
        pk: `PERSON#${person.personId}`,
        sk: `AUDIT#${next.updatedAt}#${randomUUID()}`,
        type: "personAudit",
        eventType: "person_updated",
        actor,
        previousPrimaryProviderId: person.primaryProviderId,
        previousPrimaryProgramId: person.primaryProgramId,
        primaryProviderId: next.primaryProviderId,
        primaryProgramId: next.primaryProgramId,
      },
    },
  });
  for (const guard of guards) {
    const existing = writes.find(
      (write) =>
        write.Put?.Item?.pk === guard.Key?.pk &&
        write.Put?.Item?.sk === guard.Key?.sk,
    )?.Put;
    if (existing) {
      existing.ConditionExpression += ` AND (${guard.ConditionExpression})`;
      existing.ExpressionAttributeNames = {
        ...existing.ExpressionAttributeNames,
        ...guard.ExpressionAttributeNames,
      };
      existing.ExpressionAttributeValues = {
        ...existing.ExpressionAttributeValues,
        ...guard.ExpressionAttributeValues,
      };
    } else writes.push({ ConditionCheck: guard });
  }
  if (writes.length > 100) throw new Error("person_update_limit_exceeded");
  await ddb.send(new TransactWriteCommand({ TransactItems: writes }));
  return next;
}

/** Register contacts introduced by older creation/import flows in the same transaction.
 * @param {NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]>} items
 */
export async function registerPeopleChanges(items) {
  const records = items.flatMap((item) =>
    item.Put?.Item ? [item.Put.Item] : [],
  );
  const people = new Map();
  for (const row of records.filter(
    (row) =>
      row.sk.startsWith("USER#") || row.sk.startsWith("PROVIDER_MANAGER#"),
  )) {
    if (row.personId) continue;
    let sourcePerson = null;
    if (row.staffSource) {
      const source = row.staffSource;
      const Key = source.providerManagerId
        ? {
            pk: `PROVIDER#${source.providerId}`,
            sk: `PROVIDER_MANAGER#${source.providerManagerId}`,
          }
        : { pk: `PROGRAM#${source.programId}`, sk: `USER#${source.userId}` };
      const { Item } = await ddb.send(
        new GetCommand({
          TableName: getDynamoTableName(),
          Key,
          ConsistentRead: true,
        }),
      );
      sourcePerson = await getPerson(Item?.personId);
    }
    const pending = sourcePerson ? people.get(sourcePerson.personId) : null;
    const person =
      pending?.person ||
      (sourcePerson
        ? {
            ...sourcePerson,
            sources: [...sourcePerson.sources],
            revision: randomUUID(),
          }
        : personRecord(
            {
              ...row,
              primaryProviderId: row.providerId || "",
              primaryProgramId: row.programId || "",
            },
            String(row.userId || row.membershipId),
            [],
          ));
    person.sources.push({ pk: row.pk, sk: row.sk });
    row.personId = person.personId;
    people.set(person.personId, {
      person,
      expected: pending?.expected || sourcePerson?.revision,
    });
  }
  for (const row of records.filter(
    (row) =>
      row.sk.startsWith("MANAGER_MEMBERSHIP#") ||
      row.sk.startsWith("ASSIGNED_USER#"),
  )) {
    if (!row.userId || !row.programId) continue;
    let contact = records.find(
      (c) =>
        c.pk === `PROGRAM#${row.programId}` && c.sk === `USER#${row.userId}`,
    );
    if (!contact)
      contact = (
        await ddb.send(
          new GetCommand({
            TableName: getDynamoTableName(),
            Key: { pk: `PROGRAM#${row.programId}`, sk: `USER#${row.userId}` },
            ConsistentRead: true,
          }),
        )
      ).Item;
    if (!contact?.personId) continue;
    let entry = people.get(contact.personId);
    if (!entry) {
      const current = await getPerson(contact.personId);
      if (!current) throw new Error("person_not_found");
      entry = {
        person: {
          ...current,
          sources: [...current.sources],
          revision: randomUUID(),
        },
        expected: current.revision,
      };
      people.set(contact.personId, entry);
    }
    row.personId = contact.personId;
    entry.person.siteManager = true;
    if (
      !entry.person.sources.some(
        (/** @type {{pk:string,sk:string}} */ source) =>
          source.pk === row.pk && source.sk === row.sk,
      )
    )
      entry.person.sources.push({ pk: row.pk, sk: row.sk });
  }
  return [...people.values()].map(({ person, expected }) =>
    personPut(person, expected),
  );
}
