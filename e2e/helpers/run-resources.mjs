// Each invocation owns its table/queue; workers inherit the same run identity.
import { randomUUID } from "node:crypto";

export function runResources(env = process.env) {
  const id = env.E2E_RUN_ID;
  if (
    !id ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      id,
    )
  )
    throw new Error("[e2e] missing or invalid E2E_RUN_ID");
  const tableName = `gnp-local-e2e-${id}`;
  return {
    tableName,
    queueUrl: `http://localhost:9324/local/${tableName}-submissions`,
  };
}

export function configureRunResources(env = process.env) {
  env.E2E_RUN_ID ||= randomUUID();
  const resources = runResources(env);
  env.DYNAMO_TABLE = resources.tableName;
  env.SQS_QUEUE_URL = resources.queueUrl;
  return resources;
}

/** Validate exact owned resources before any setup/cleanup mutation. */
export function assertRunResources(env = process.env) {
  const resources = runResources(env);
  if (
    env.DYNAMO_TABLE !== resources.tableName ||
    env.SQS_QUEUE_URL !== resources.queueUrl
  )
    throw new Error("[e2e] refusing to mutate resources outside this run");
  return resources;
}
