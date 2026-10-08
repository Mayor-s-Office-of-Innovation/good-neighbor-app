import {
  AdminAddUserToGroupCommand,
  CognitoIdentityProviderClient,
  ListUsersInGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const pool = process.env.COGNITO_USER_POOL_ID;
const apply = process.argv.includes("--apply");
const supervisors = new Set(
  process.argv
    .filter((value) => value.startsWith("--supervisor="))
    .map((value) => value.slice("--supervisor=".length).toLowerCase()),
);
if (!pool) throw new Error("COGNITO_USER_POOL_ID is required");
if (apply && process.env.ENVIRONMENT !== "dev")
  throw new Error("--apply is restricted to ENVIRONMENT=dev");
if (apply && supervisors.size === 0)
  throw new Error("--apply requires at least one --supervisor=<username>");

const cognito = new CognitoIdentityProviderClient({});
const users = [];
let NextToken;
do {
  const page = await cognito.send(
    new ListUsersInGroupCommand({
      UserPoolId: pool,
      GroupName: "central-admin",
      ...(NextToken ? { NextToken } : {}),
    }),
  );
  users.push(...(page.Users ?? []));
  NextToken = page.NextToken;
} while (NextToken);

const plan = users.map((user) => ({
  username: user.Username,
  role: supervisors.has(String(user.Username).toLowerCase())
    ? "compliance-supervisor"
    : "compliance-manager",
}));

if (apply) {
  for (const entry of plan) {
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: pool,
        Username: entry.username,
        GroupName: entry.role,
      }),
    );
  }
}

console.log(
  JSON.stringify(
    {
      mode: apply ? "apply" : "dry-run",
      plan,
      note: apply
        ? "Legacy central-admin membership was retained for rollback."
        : "No Cognito memberships were changed.",
    },
    null,
    2,
  ),
);
