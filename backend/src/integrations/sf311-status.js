/** @type {Record<string, string>} */
const STATUS_NAMES = {
  1: "New",
  2: "Accepted",
  3: "Prioritized",
  4: "Closed",
  5: "In progress",
  6: "On hold",
  7: "Scheduled",
  8: "Deferred",
  9: "Open",
  10: "Sent",
};

/** @type {Record<string, string>} */
const PRIORITY_NAMES = {
  0: "Very High",
  1: "High",
  2: "Medium/High",
  3: "Medium",
  4: "Low",
  5: "Very Low",
};

/** @type {Record<string, string>} */
const CLOSED_REASONS = {
  1: "Resolved",
  2: "Duplicate",
  3: "Cancelled",
  4: "Transferred",
  5: "Resolved - Multiagency",
  6: "Unable to Locate",
  7: "Insufficient Information",
  8: "Field Work Completed",
  9: "No Merit",
};

/** @type {Record<string, string>} */
export const AGENCY_NAMES = {
  1: "Department of Public Works (DPW)",
  2: "Department of Public Works (DPW)",
  3: "Department of Public Works (DPW)",
  4: "San Francisco Public Utilities Commission (SFPUC)",
  5: "San Francisco Public Utilities Commission (SFPUC)",
  6: "San Francisco Public Utilities Commission (SFPUC)",
  7: "San Francisco Public Utilities Commission (SFPUC)",
  8: "San Francisco Public Utilities Commission (SFPUC)",
  9: "San Francisco Public Utilities Commission (SFPUC)",
  10: "San Francisco Municipal Transportation Agency (SFMTA)",
  11: "San Francisco Municipal Transportation Agency (SFMTA)",
  12: "San Francisco Municipal Transportation Agency (SFMTA)",
  13: "San Francisco Municipal Transportation Agency (SFMTA)",
  14: "Department of Public Works (DPW)",
  15: "SF311 Customer Service Center",
  16: "Department of Public Works (DPW)",
  17: "San Francisco Public Utilities Commission (SFPUC)",
  18: "San Francisco Municipal Transportation Agency (SFMTA)",
  19: "Department of Public Works (DPW)",
  20: "Department of Public Works (DPW)",
  21: "Recology San Francisco",
  22: "Recology San Francisco",
  23: "Recology San Francisco",
  24: "Recology San Francisco",
  25: "Department of Technology (DT)",
  26: "SF311 Customer Service Center",
  27: "Pacific Gas & Electric (PG&E)",
  28: "San Francisco Public Utilities Commission (SFPUC)",
  29: "San Francisco Public Utilities Commission (SFPUC)",
  30: "Department of Public Health (DPH)",
  31: "San Francisco Police Department (SFPD)",
  32: "United States Postal Service (USPS)",
  33: "Mayor's Office of Neighborhood Services (MONS)",
  34: "Office of the City Administrator",
  35: "Department of Public Works (DPW)",
  36: "AT&T",
  37: "San Francisco Municipal Transportation Agency (SFMTA)",
  38: "San Francisco Municipal Transportation Agency (SFMTA)",
  39: "San Francisco Municipal Transportation Agency (SFMTA)",
  40: "San Francisco Municipal Transportation Agency (SFMTA)",
  41: "San Francisco Municipal Transportation Agency (SFMTA)",
  42: "SF311 Customer Service Center",
  43: "Recreation and Park Department (RPD)",
  44: "Recreation and Park Department (RPD)",
  45: "Office of the City Administrator",
  46: "Department of Public Works (DPW)",
  47: "Department of Public Works (DPW)",
  48: "Department of Public Works (DPW)",
  49: "Department of Public Works (DPW)",
  50: "Department of Emergency Management (DEM)",
  51: "Department of Public Health (DPH)",
  52: "Mayor's Office on Disability (MOD)",
  53: "San Francisco Planning Department",
  54: "San Francisco Fire Department (SFFD)",
  55: "San Francisco Municipal Transportation Agency (SFMTA)",
  56: "Human Services Agency (HSA)",
  57: "Shared Spaces Program",
  58: "Department of Public Health (DPH)",
  59: "Department of Public Works (DPW)",
  60: "Unknown agency",
  61: "Tenderloin Community Benefit District",
  62: "Department of Emergency Management (DEM)",
  63: "SoMa West Community Benefit District",
  64: "Downtown SF Partnership",
  65: "The East Cut Community Benefit District",
  66: "Fisherman's Wharf Community Benefit District",
  67: "Japantown Community Benefit District",
  68: "Yerba Buena Community Benefit District",
  69: "Unknown agency",
  70: "Unknown agency",
  71: "Department of Public Works (DPW)",
  72: "Department of Public Works (DPW)",
  73: "San Francisco Public Utilities Commission (SFPUC)",
  74: "San Francisco Public Utilities Commission (SFPUC)",
  76: "Department of Homelessness and Supportive Housing (HSH)",
};

/** @param {unknown} value */
const clean = (value) => (value == null ? "" : String(value).trim());
/** @param {Record<string, unknown>} record @param {...string} keys */
const first = (record, ...keys) =>
  keys.map((key) => clean(record[key])).find(Boolean) || "";
/** @param {unknown} code */
const agencyName = (code) => AGENCY_NAMES[clean(code)] || "";

/** Locate service-request-shaped records without exposing the upstream schema. */
/** @param {unknown} body @param {string} srNum @returns {Record<string, unknown> | null} */
export function findServiceRequest(body, srNum) {
  const wanted = clean(srNum);
  const stack = [body];
  /** @type {Record<string, unknown>[]} */
  const matches = [];
  while (stack.length) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const record = /** @type {Record<string, unknown>} */ (value);
    const candidate = first(
      record,
      "SRNum",
      "SRnum",
      "ServiceRequestNumber",
      "service_request_id",
    );
    if (candidate === wanted) matches.push(record);
    stack.push(...Object.values(record));
  }
  if (!matches.length) return null;
  const base =
    matches.find((record) => requestUpdates(record).length) ?? matches[0];
  if (requestUpdates(base).length || matches.length === 1) return base;
  return { ...base, Updates: matches };
}

/** @param {...unknown} values */
function validDate(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text && Number.isFinite(Date.parse(text)))
      return new Date(text).toISOString();
  }
  return "";
}

/** @param {Record<string, unknown>} update */
function updateEvent(update) {
  const type = first(update, "UpdateType", "update_type");
  const numeric = first(update, "NumericSubType", "numeric_sub_type");
  const text = first(update, "TextSubType", "text_sub_type");
  const notes = first(update, "Notes", "notes");
  const agency =
    agencyName(numeric) || agencyName(first(update, "SendingAgency"));
  let title = "";
  let description = "";
  if (type === "1" && agency)
    title = `Ticket assigned to a new agency: ${agency}`;
  else if (type === "2" && PRIORITY_NAMES[numeric])
    title = `Priority on this ticket was updated to ${PRIORITY_NAMES[numeric]}`;
  else if (type === "3" && STATUS_NAMES[numeric])
    title = `Ticket status changed to ${STATUS_NAMES[numeric]}`;
  else if (type === "5") {
    title = "Agency update";
    description = notes || text;
  } else if (type === "6") title = "Work has been completed on this ticket";
  else if (type === "9") {
    title = "Problem details have been updated";
    description = notes;
  } else if (type === "10") title = "The ticket was accepted for action";
  else if (type === "11" && CLOSED_REASONS[numeric]) {
    title = "The ticket was resolved";
    description = [`Agency said: ${CLOSED_REASONS[numeric]}`, notes]
      .filter(Boolean)
      .join("\n");
  } else if (type === "12" && text)
    title = `Another ticket was linked to this, #${text}`;
  else if (type === "14" && agency)
    title = `${agency} has received this ticket and is reviewing`;
  if (!title) return null;
  const occurredAt = validDate(
    update.EffectiveDate,
    update.ToHubDate,
    update.ToAgencyDate,
  );
  if (!occurredAt) return null;
  return { title, occurredAt, ...(description ? { description } : {}) };
}

/** @param {Record<string, unknown>} record @returns {unknown[]} */
function requestUpdates(record) {
  const candidates = [
    record.Updates,
    record.updates,
    record.Update,
    record.StatusUpdates,
  ];
  for (const value of candidates) if (Array.isArray(value)) return value;
  return [];
}

/** @param {Record<string, unknown>} update */
function updateDate(update) {
  return validDate(update.EffectiveDate, update.ToHubDate, update.ToAgencyDate);
}

/**
 * Resolve the latest HUB status-affecting update. A ClosedReason update closes
 * the request even when the upstream summary record still carries a stale
 * active status.
 * @param {Record<string, unknown>} record
 */
function latestStatusCode(record) {
  const candidates = requestUpdates(record)
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const update = /** @type {Record<string, unknown>} */ (item);
      const type = first(update, "UpdateType", "update_type");
      const numeric = first(update, "NumericSubType", "numeric_sub_type");
      const code = type === "11" ? "4" : type === "3" ? numeric : "";
      const occurredAt = updateDate(update);
      return code && STATUS_NAMES[code] && occurredAt
        ? [{ code, occurredAt }]
        : [];
    })
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  return candidates[0]?.code || "";
}

/** Normalize a HUB record into the app's stable, PII-free ticket-detail contract. */
/** @param {{record: Record<string, unknown>, task: Record<string, any>, srNum: string, now?: Date}} params */
export function normalizeSf311Detail({
  record,
  task,
  srNum,
  now = new Date(),
}) {
  const closedReasonUpdate = requestUpdates(record)
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        first(
          /** @type {Record<string, unknown>} */ (item),
          "UpdateType",
          "update_type",
        ) === "11",
    )
    .sort((a, b) =>
      updateDate(/** @type {Record<string, unknown>} */ (b)).localeCompare(
        updateDate(/** @type {Record<string, unknown>} */ (a)),
      ),
    )[0];
  const closedReasonCode =
    first(record, "ClosedReason", "ClosedReasonCode", "closed_reason") ||
    (closedReasonUpdate && typeof closedReasonUpdate === "object"
      ? first(
          /** @type {Record<string, unknown>} */ (closedReasonUpdate),
          "NumericSubType",
          "numeric_sub_type",
        )
      : "");
  const recordStatusCode = first(record, "Status", "StatusCode", "status");
  const eventStatusCode = latestStatusCode(record);
  const statusCode =
    eventStatusCode ||
    (closedReasonCode ? "4" : "") ||
    (STATUS_NAMES[recordStatusCode] ? recordStatusCode : "9");
  const status = STATUS_NAMES[statusCode] || "Open";
  const submittedAt = validDate(
    record.SourceAgencyReceiveDate,
    record.ToHubDate,
    task.createdAt,
  );
  const maxHours = Number(task.maxAcceptableResponseHours);
  const expectedResponseAt =
    maxHours > 0 && submittedAt
      ? new Date(Date.parse(submittedAt) + maxHours * 3_600_000).toISOString()
      : "";
  const overdue =
    status !== "Closed" &&
    expectedResponseAt &&
    now.getTime() > Date.parse(expectedResponseAt);
  const events = requestUpdates(record)
    .map((item) =>
      item && typeof item === "object"
        ? updateEvent(/** @type {Record<string, unknown>} */ (item))
        : null,
    )
    .filter((item) => item !== null);
  if (submittedAt)
    events.push({ title: "Ticket submitted", occurredAt: submittedAt });
  events.sort((a, b) =>
    String(b.occurredAt).localeCompare(String(a.occurredAt)),
  );
  const agencyCode = first(
    record,
    "ResponsibleAgency",
    "AssignedAgency",
    "responsible_agency",
  );
  const location =
    first(record, "LocationDescription", "Address", "address") ||
    task.georeferencedAddress ||
    task.address ||
    task.evidence?.placeName ||
    "";
  const relevantDate = events[0]?.occurredAt || submittedAt;
  const closureReason = CLOSED_REASONS[closedReasonCode] || "";
  const statusDetail =
    status === "Closed" && closureReason
      ? closureReason.toLocaleLowerCase()
      : overdue
        ? "response overdue"
        : "";
  return {
    requestNumber: clean(srNum),
    status,
    responseOverdue: Boolean(overdue),
    ...(statusDetail ? { statusDetail } : {}),
    ...(closureReason ? { closureReason } : {}),
    ...(location ? { location } : {}),
    problemType:
      task.userFriendlyLabel || task.category || task.analyzerCategory || "",
    ...(task.guidance ? { guidance: task.guidance } : {}),
    ...(agencyName(agencyCode)
      ? { assignedAgency: agencyName(agencyCode) }
      : {}),
    ...(submittedAt
      ? {
          submittedAt,
          ageHours: Math.max(
            0,
            Math.floor((now.getTime() - Date.parse(submittedAt)) / 3_600_000),
          ),
        }
      : {}),
    ...(relevantDate ? { relevantDate } : {}),
    ...(expectedResponseAt ? { expectedResponseAt } : {}),
    events,
    refreshedAt: now.toISOString(),
  };
}
