import { AsyncLocalStorage } from "node:async_hooks";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";

export const silent311Key = { pk: "SYSTEM#CONTROLS", sk: "SILENT_311" };
const context = new AsyncLocalStorage();
export class Silent311Suppressed extends Error {
  constructor() {
    super("Silent 311 workflow suppressed");
  }
}
export async function readSilent311Control() {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: getConfig().dynamoTable,
      Key: silent311Key,
      ConsistentRead: true,
    }),
  );
  return {
    enabled: Item?.enabled !== false,
    revision: Number(Item?.revision || 0),
    epochStartedAt: String(Item?.epochStartedAt || ""),
  };
}
/** @param {Record<string, any>} task */
export function isSilent311Task(task) {
  return [...(task.appActions || []), ...(task.appActionResults || [])].some(
    (action) =>
      action.code === "create_311_ticket" &&
      action.payload?.executionTrigger === "task_created",
  );
}
/** Each new enablement admits only new workflows; disabled work never replays.
 * @param {string | undefined} createdAt
 */
export async function assertSilent311Allowed(
  createdAt = context.getStore()?.createdAt,
) {
  if (!context.getStore() && createdAt === undefined) return;
  const control = await readSilent311Control();
  if (
    !control.enabled ||
    (control.epochStartedAt &&
      (!createdAt ||
        !Number.isFinite(Date.parse(createdAt)) ||
        Date.parse(createdAt) <= Date.parse(control.epochStartedAt)))
  )
    throw new Silent311Suppressed();
}
/** @template T @param {string} createdAt @param {() => Promise<T>} run */
export function withSilent311Guard(createdAt, run) {
  return context.run({ createdAt }, async () => {
    await assertSilent311Allowed();
    return run();
  });
}

/** Classify the actual target, so a later manual ticket is never suppressed.
 * @param {Record<string, any>} task @param {string} srNum
 */
export function isSilent311Ticket(task, srNum) {
  const filing = (task.appActionResults || []).find(
    (/** @type {Record<string, any>} */ result) =>
      result.code === "create_311_ticket" &&
      (result.payload?.tickets || []).some(
        (/** @type {Record<string, any>} */ ticket) =>
          String(ticket.srNum) === srNum,
      ),
  );
  if (filing?.payload?.executionTrigger)
    return filing.payload.executionTrigger === "task_created";
  return isSilent311Task(task);
}
