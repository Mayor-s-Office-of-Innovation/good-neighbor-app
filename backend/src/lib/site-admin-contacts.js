// Site-scoped contact views; resolve current profiles instead of assignment snapshots.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getDynamoTableName } from "../config.js";
import { getPerson } from "./people.js";
import { queryAllItems } from "./query-all-items.js";
import { boundedReads } from "./admin-site-reads.js";

/** @param {string} siteId @param {string} prefix */
async function assignments(siteId, prefix) {
  const result = await queryAllItems({
    TableName: getDynamoTableName(),
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `SITE#${siteId}`, ":prefix": prefix },
    ConsistentRead: true,
  });
  return result.Items.filter((row) => row.status === "active");
}

/** Resolve explicit links only; never infer a person's identity from their email.
 * @param {Record<string, any>} assignment
 */
async function assignedProfile(assignment) {
  let person = await getPerson(assignment.personId);
  /** @type {Record<string, any> | undefined} */
  let source = assignment;
  if (!assignment.personId && assignment.programId && assignment.userId) {
    source = (
      await ddb.send(
        new GetCommand({
          TableName: getDynamoTableName(),
          Key: {
            pk: `PROGRAM#${assignment.programId}`,
            sk: `USER#${assignment.userId}`,
          },
          ConsistentRead: true,
        }),
      )
    ).Item;
    if (!source || source.status !== "active") return null;
    person = await getPerson(source.personId);
  }
  if (
    (assignment.personId || source?.personId) &&
    (!person || person.status !== "active")
  )
    return null;
  return { assignment, profile: person || source, person };
}

/** @param {string} siteId */
export async function siteManagerProfiles(siteId) {
  const rows = [
    ...(await assignments(siteId, "MANAGER_MEMBERSHIP#")),
    ...(await assignments(siteId, "ASSIGNED_USER#")),
  ];
  const resolved = await boundedReads(rows, assignedProfile);
  const seen = new Set();
  return resolved.filter((entry) => {
    if (!entry) return false;
    const id =
      entry.person?.personId ||
      `${entry.assignment.programId}:${entry.assignment.userId || entry.assignment.membershipId}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Public shape deliberately excludes membership authority and person source references.
 * @param {Record<string, any>} profile
 */
export function publicContactProfile(profile) {
  return {
    personId: profile.personId || "",
    name:
      [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
      profile.name ||
      "",
    email: profile.email || "",
    phone: profile.phone || "",
    phoneExtension: profile.phoneExtension || "",
  };
}

/** @param {string} siteId */
export async function siteContacts(siteId) {
  const [managers, assignedCity] = await Promise.all([
    siteManagerProfiles(siteId),
    assignments(siteId, "COMPLIANCE_MANAGER#"),
  ]);
  /** @type {Record<string, any>[]} */
  let cityProgramManagers = [];
  if (assignedCity.length) {
    const directory = await queryAllItems({
      TableName: getDynamoTableName(),
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "ADMIN_DIRECTORY#PROGRAM_MANAGERS" },
      ConsistentRead: true,
    });
    const ids = new Set(assignedCity.map((row) => row.managerId));
    cityProgramManagers = directory.Items.filter(
      (row) => row.status === "active" && ids.has(row.userId),
    ).map((row) => ({
      ...publicContactProfile(row),
      department: row.departmentName || "",
    }));
  }
  return {
    siteManagers: managers.map(({ profile, person }) => ({
      ...publicContactProfile(profile),
      canEditPhone: Boolean(person),
    })),
    cityProgramManagers,
  };
}
