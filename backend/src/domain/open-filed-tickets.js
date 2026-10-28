const TERMINAL = new Set(["closed", "completed", "resolved"]);

/** @param {unknown} value */
function ticketNumber(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Recorded filing references without a recorded successful closure. A failed
 * closure does not close a ticket, and one closed ticket does not close its peers.
 * @param {{appActionResults?: Array<Record<string, any>>}} task
 * @returns {string[]}
 */
export function openFiledTicketNumbers(task) {
  const results = task.appActionResults || [];
  const closed = new Set(
    results
      .filter((result) => result.code === "close_311_ticket")
      .flatMap((result) => result.payload?.closures || [])
      .filter((entry) => entry.status === "closed")
      .map((entry) => ticketNumber(entry.srNum)),
  );
  return results
    .filter(
      (result) =>
        result.code === "create_311_ticket" &&
        !TERMINAL.has(String(result.status || "").toLowerCase()),
    )
    .flatMap((result) => result.payload?.tickets || [])
    .map((ticket) => ticketNumber(ticket.srNum))
    .filter((srNum) => srNum && !closed.has(srNum));
}
