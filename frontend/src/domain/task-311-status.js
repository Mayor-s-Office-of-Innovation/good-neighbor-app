/*
  task-311-status — fold the live SF311 status of filed tickets onto task
  cards. Shared by the home hub and the reports day view: both fetch one
  `get311RequestDetails` batch for the tasks with a submitted ticket and
  stamp the result onto each card before rendering.
*/
import { submitted311Ticket } from "./home-tasks.js";

/**
 * @typedef {{ status: string, statusDetail: string, responseOverdue: boolean, updatedAt: string }} Ticket311State
 */

/**
 * The `{ taskId, srNum }` pairs to ask SF311 about.
 * @param {Record<string, any>[]} tasks
 */
export function submitted311Requests(tasks) {
  return tasks.flatMap((task) => {
    const ticket = submitted311Ticket(task);
    return task?.taskId && ticket?.srNum
      ? [{ taskId: task.taskId, srNum: ticket.srNum }]
      : [];
  });
}

/**
 * Index a `get311RequestDetails` response by task id.
 * @param {{ requests?: Array<{ taskId?: string, request?: Record<string, any> }> } | null | undefined} response
 * @returns {Map<string, Ticket311State>}
 */
export function map311StatusResponse(response) {
  return new Map(
    (response?.requests || []).flatMap(({ taskId, request }) =>
      taskId && request?.status
        ? [
            [
              taskId,
              {
                status: request.status,
                statusDetail: request.statusDetail || "",
                responseOverdue: Boolean(request.responseOverdue),
                updatedAt: request.relevantDate || request.submittedAt || "",
              },
            ],
          ]
        : [],
    ),
  );
}

/**
 * The task with its card-facing ticket fields set from the live status.
 * Tasks without a submitted ticket are returned as-is.
 * @param {Record<string, any>} task
 * @param {Map<string, Ticket311State>} statusByTaskId
 */
export function taskWith311Status(task, statusByTaskId) {
  if (!submitted311Ticket(task)) return task;
  const state = statusByTaskId.get(task.taskId);
  return {
    ...task,
    ticketStatus: state?.status || "",
    ticketStatusDetail: state?.statusDetail || "",
    ticketResponseOverdue: Boolean(state?.responseOverdue),
    ticketUpdatedAt: state?.updatedAt || task.createdAt || "",
  };
}
