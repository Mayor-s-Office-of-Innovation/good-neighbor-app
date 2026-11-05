import { sameAppAction } from "../analysis/guidance/app-actions.js";
import { mergeBackgroundResult } from "../workers/sf311-job.js";

/**
 * Report retained outcomes, not event totals. A manual simulation never clears
 * a separate silent failure. Historical actions remain visible but separate.
 * No narratives, City response bodies, media references or credentials leave here.
 * @param {Record<string, any>[]} items
 */
export function summarize311Recovery(items) {
  const tasks = items.filter((item) => item.sk?.startsWith("TASK#"));
  const jobs = items.filter((item) => item.sk?.startsWith("SF311_JOB#"));
  const knownTasks = new Set(tasks.map((task) => task.taskId));
  const orphanIds = new Set(
    jobs
      .map((job) => job.taskId || job.sk.split("#")[1])
      .filter((id) => !knownTasks.has(id)),
  );
  /** @type {Record<string, any>[]} */
  const reportTasks = [
    ...tasks,
    ...[...orphanIds].map((taskId) => ({ taskId, status: "missing" })),
  ];
  const failures = [];
  let excludedCode21Results = 0;
  for (const task of reportTasks) {
    // Checkpoints are written to jobs before the task's final update. Merge
    // those too, preserving confirmed SRs over stale pending snapshots. For an
    // equal timestamp prefer the task, which is written after checkpoints.
    const retained = [
      ...jobs
        .filter((job) => (job.taskId || job.sk.split("#")[1]) === task.taskId)
        .flatMap((job) => job.results || []),
      ...(task.appActionResults || []),
    ].sort((a, b) =>
      String(a.recordedAt || "").localeCompare(String(b.recordedAt || "")),
    );
    /** @type {import("../analysis/guidance/app-actions.js").AppActionResult[]} */
    let merged = [];
    for (const result of retained)
      merged = mergeBackgroundResult(merged, result);
    for (let result of merged) {
      const related = retained.filter((entry) => sameAppAction(entry, result));
      /** @type {Record<string, any>[]} */
      const evidence = related.flatMap((entry) =>
        Array.isArray(entry.payload?.tickets) ? entry.payload.tickets : [],
      );
      const pending = evidence.filter(
        (ticket) =>
          ticket.creationState === "pending" &&
          !ticket.srNum &&
          !evidence.some(
            (confirmed) =>
              confirmed.srNum &&
              confirmed.serviceCode === ticket.serviceCode &&
              (!ticket.sourceRequestId ||
                !confirmed.sourceRequestId ||
                ticket.sourceRequestId === confirmed.sourceRequestId),
          ),
      );
      // A later failed attempt is not evidence that an earlier uncertain City
      // creation did nothing. Keep that uncertainty visible, including when
      // the newer result is an excluded code-21 failure.
      if (pending.length)
        result = {
          ...result,
          status: "partial",
          reason: "creation_pending",
          payload: {
            ...result.payload,
            tickets: [
              ...(Array.isArray(result.payload?.tickets)
                ? result.payload.tickets
                : []),
              ...pending,
            ],
          },
        };
      if (
        result.code !== "create_311_ticket" ||
        !["failed", "partial"].includes(result.status)
      )
        continue;
      if (["21", "hub_21"].includes(String(result.reason))) {
        excludedCode21Results++;
        continue;
      }
      const active =
        task.status !== "superseded" &&
        [
          ...(task.appActions || []),
          ...(task.silent311Snapshot?.appActions || []),
        ].some(
          (
            /** @type {import("../analysis/guidance/app-actions.js").AppAction} */ action,
          ) => sameAppAction(action, result),
        );
      /** @type {Record<string, any>[]} */
      const tickets = Array.isArray(result.payload?.tickets)
        ? result.payload.tickets
        : [];
      failures.push({
        taskId: task.taskId,
        taskStatus: task.status,
        filingType:
          result.payload?.executionTrigger === "task_created"
            ? "silent"
            : result.payload?.executionTrigger === "user_confirmed"
              ? "manual"
              : "unknown",
        applicability:
          task.status === "missing"
            ? "missing_task"
            : active
              ? "current_action"
              : "historical_action",
        reason: /^[a-z_]{1,100}$/.test(result.reason || "")
          ? result.reason
          : "unspecified",
        recordedAt: result.recordedAt,
        hasRecordedTicket: tickets.some(
          (/** @type {Record<string, any>} */ ticket) => Boolean(ticket.srNum),
        ),
        uncertainCreation: tickets.some(
          (/** @type {Record<string, any>} */ ticket) =>
            ticket.creationState === "pending" && !ticket.srNum,
        ),
      });
    }
  }
  /** @type {Record<string, number>} */
  const jobStatuses = {};
  for (const job of jobs)
    jobStatuses[job.status || "unknown"] =
      (jobStatuses[job.status || "unknown"] || 0) + 1;
  return {
    tasksRead: tasks.length,
    jobsRead: jobs.length,
    jobStatuses,
    excludedCode21Results,
    tasksWithCurrentFailures: new Set(
      failures
        .filter((f) => f.applicability === "current_action")
        .map((f) => f.taskId),
    ).size,
    tasksWithHistoricalFailures: new Set(
      failures
        .filter((f) => f.applicability === "historical_action")
        .map((f) => f.taskId),
    ).size,
    failures,
  };
}
