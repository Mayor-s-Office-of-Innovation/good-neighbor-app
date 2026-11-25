import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  adminOnly,
  adminPrincipal,
  authorizeSiteChanges,
} from "../lib/admin-auth.js";
import { queryAllItems } from "../lib/query-all-items.js";
import {
  getPerson,
  personPut,
  personRecord,
  updatePersonRecord,
} from "../lib/people.js";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { assignedSiteIds } from "../lib/assignment-pointers.js";
import { jsonResponse } from "../http.js";

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const listPeople = (event) =>
  adminOnly(event, async () => {
    const { Items = [] } = await queryAllItems({
      TableName: getDynamoTableName(),
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "PEOPLE" },
      ConsistentRead: true,
    });
    return jsonResponse(200, {
      people: Items.filter((row) => row.status !== "inactive"),
    });
  });
/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const createPerson = (event) =>
  adminOnly(event, async (body) => {
    if (adminPrincipal(event).role !== "compliance-supervisor") {
      const denied = await authorizeSiteChanges(event, [
        String(body.siteId || ""),
      ]);
      if (denied) return denied;
      if (body.primaryProviderId || body.primaryProgramId)
        return jsonResponse(403, { error: "supervisor_required" });
    }
    const person = personRecord({ ...body, siteManager: true });
    if (
      !person.firstName ||
      !person.lastName ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.email) ||
      person.firstName.length > 100 ||
      person.lastName.length > 100 ||
      person.email.length > 320 ||
      person.phone.length > 40 ||
      person.phoneExtension.length > 20
    )
      return jsonResponse(400, { error: "invalid_person_contact" });
    const affiliationChecks = [];
    for (const [id, prefix] of [
      [person.primaryProviderId, "PROVIDER"],
      [person.primaryProgramId, "PROGRAM"],
    ]) {
      if (!id) continue;
      const Key = { pk: `${prefix}#${id}`, sk: "#META" };
      const { Item } = await ddb.send(
        new GetCommand({
          TableName: getDynamoTableName(),
          Key,
          ConsistentRead: true,
        }),
      );
      if (!Item || Item.status !== "active")
        return jsonResponse(400, { error: "affiliation_not_found" });
      affiliationChecks.push({
        ConditionCheck: {
          TableName: getDynamoTableName(),
          Key,
          ConditionExpression: "#status = :active",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":active": "active" },
        },
      });
    }
    // Creation has no assignments and grants no app access.
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [personPut(person), ...affiliationChecks],
      }),
    );
    return jsonResponse(201, { person });
  });
/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const updatePerson = (event) =>
  adminOnly(event, async (body) => {
    const person = await getPerson(event.pathParameters?.personId);
    if (!person || person.status !== "active")
      return jsonResponse(404, { error: "person_not_found" });
    const principal = adminPrincipal(event);
    if (principal.role !== "compliance-supervisor") {
      if (
        body.email !== person.email ||
        (body.primaryProviderId !== undefined &&
          body.primaryProviderId !== person.primaryProviderId) ||
        (body.primaryProgramId !== undefined &&
          body.primaryProgramId !== person.primaryProgramId) ||
        person.sources.some((/** @type {{pk:string,sk:string}} */ source) =>
          source.sk.startsWith("PROVIDER_MANAGER#"),
        )
      )
        return jsonResponse(403, { error: "supervisor_required" });
      const sites = [
        ...new Set(
          person.sources
            .filter((/** @type {{pk:string,sk:string}} */ source) =>
              source.pk.startsWith("SITE#"),
            )
            .map((/** @type {{pk:string,sk:string}} */ source) =>
              source.pk.slice(5),
            ),
        ),
      ];
      const denied = await authorizeSiteChanges(event, sites);
      if (denied) return denied;
      const programSources = person.sources.filter(
        (/** @type {{pk:string,sk:string}} */ source) =>
          source.pk.startsWith("PROGRAM#") && source.sk.startsWith("USER#"),
      );
      if (programSources.length) {
        const tableName = getDynamoTableName();
        const authorizedSiteMetas = await Promise.all(
          sites.map((siteId) =>
            ddb.send(
              new GetCommand({
                TableName: tableName,
                Key: { pk: `SITE#${siteId}`, sk: "#META" },
                ConsistentRead: true,
              }),
            ),
          ),
        );
        const authorizedLeadPrograms = new Set(
          authorizedSiteMetas
            .map((res) => String(res.Item?.leadProgramId || ""))
            .filter(Boolean),
        );
        // A program staff record may only be edited from a Site that program
        // leads, and only by a manager of every Site that shows this person:
        // other Sites read the shared person record, not their own copy. The
        // assignment pointers list those Sites (`sources` doesn't track later
        // assignments); if they disagree with the record's own count, the
        // index can't be trusted for this person and a supervisor edits.
        const assignedSites = new Set();
        for (const source of programSources) {
          const programId = source.pk.slice(8);
          if (!authorizedLeadPrograms.has(programId)) {
            return jsonResponse(403, { error: "site_assignment_required" });
          }
          const userId = source.sk.slice(5);
          const [userResult, pointedSites] = await Promise.all([
            ddb.send(
              new GetCommand({
                TableName: tableName,
                Key: { pk: source.pk, sk: source.sk },
                ConsistentRead: true,
              }),
            ),
            assignedSiteIds(tableName, programId, userId),
          ]);
          if (
            pointedSites.length !==
            Number(userResult.Item?.siteAssignmentCount ?? 0)
          ) {
            return jsonResponse(403, { error: "supervisor_required" });
          }
          for (const siteId of pointedSites) assignedSites.add(siteId);
        }
        const others = [...assignedSites].filter((id) => !sites.includes(id));
        if (others.length) {
          const otherDenied = await authorizeSiteChanges(event, others);
          if (otherDenied) return otherDenied;
        }
      }
    }
    try {
      return jsonResponse(200, {
        person: await updatePersonRecord(person, body, principal.subject),
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (error.name === "TransactionCanceledException")
        return jsonResponse(409, { error: "person_update_conflict" });
      if (
        [
          "invalid_person_contact",
          "affiliation_not_found",
          "person_source_conflict",
          "person_update_limit_exceeded",
        ].includes(error.message)
      )
        return jsonResponse(409, { error: error.message });
      throw error;
    }
  });
