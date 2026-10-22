import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getDynamoTableName } from "../config.js";
import {
  generateSetupCode,
  setupCodePk,
  setupCodeVerifier,
} from "./setup-codes.js";

// Use the existing keyed short-code verifier; never persist the emailed code.
export const enrollmentCodeVerifier = setupCodeVerifier;

/** Use the standard six-character uppercase letter/digit format, avoiding existing logins. */
export async function generateEnrollmentCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = generateSetupCode();
    const keys = [
      await setupCodePk(code),
      `SITE_CODE#${code}`,
      `ENROLLMENT_TOKEN#${await enrollmentCodeVerifier(code)}`,
    ];
    const rows = await Promise.all(
      keys.map((pk) =>
        ddb.send(
          new GetCommand({
            TableName: getDynamoTableName(),
            Key: { pk, sk: "#META" },
            ConsistentRead: true,
          }),
        ),
      ),
    );
    if (rows.every((row) => !row.Item)) return code;
  }
  throw new Error("Unable to allocate an enrollment code");
}
