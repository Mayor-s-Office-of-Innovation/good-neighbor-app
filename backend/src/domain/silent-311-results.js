/** A recorded failure that proves a silent attempt created no City ticket.
 * @param {Record<string, any>} result
 */
export function definitiveSilentFailure(result) {
  if (
    result.code !== "create_311_ticket" ||
    result.status !== "failed" ||
    result.payload?.executionTrigger !== "task_created" ||
    String(result.payload?.responsibleAgencyCode) !== "76" ||
    result.externalId ||
    /uncertain|reconciliation/.test(String(result.reason || ""))
  )
    return false;
  const tickets = /** @type {Array<Record<string, any>>} */ (
    result.payload?.tickets || []
  );
  if (tickets.length)
    return tickets.every(
      (ticket) =>
        !ticket.srNum &&
        ticket.creationState === "rejected" &&
        String(ticket.responsibleAgency) === "76",
    );
  return [
    "missing_location",
    "missing_service_code",
    "no_service_codes",
    "insufficient_classifier_information",
    "responsible_agency_not_found",
  ].includes(result.reason);
}
