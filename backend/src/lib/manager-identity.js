import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";

/** Resolve legacy roster rows that predate embedded contact details.
 * @param {string} tableName @param {Record<string, any>[]} assignments @param {string} email
 */
export async function assignmentsMatchingEmail(tableName, assignments, email) {
  const matches = [];
  for (const assignment of assignments) {
    let candidateEmail = assignment.email;
    if (!candidateEmail && assignment.programId && assignment.userId) {
      const { Item: user } = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: {
            pk: `PROGRAM#${assignment.programId}`,
            sk: `USER#${assignment.userId}`,
          },
          ConsistentRead: true,
        }),
      );
      candidateEmail = user?.email;
    }
    if (
      candidateEmail &&
      String(candidateEmail).trim().toLowerCase() === email.trim().toLowerCase()
    )
      matches.push(assignment);
  }
  return matches;
}
