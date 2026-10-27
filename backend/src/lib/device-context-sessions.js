// Independent browser containers under one managed DEVICE# identity. Existing
// tokens without sid remain the primary session on the device record.
export const CONTEXT_SESSION_LIMIT = 8;

/** @param {Record<string, any>} device @param {{sid?: string, ver: number}} claims */
export function deviceSessionMatches(device, claims) {
  if (!claims.sid)
    return (
      device.primarySessionStatus !== "signed_out" &&
      device.tokenGeneration === claims.ver
    );
  const session = device.sessions?.[claims.sid];
  return Boolean(
    session?.status === "active" &&
      session.tokenGeneration === claims.ver &&
      Date.parse(session.expiresAt) > Date.now(),
  );
}

/** @param {Record<string, any>} device @param {string} id @param {string} refreshJti @param {number} generation @param {string} now */
export function contextSession(device, id, refreshJti, generation, now) {
  return {
    kind: device.sessions?.[id]?.kind ?? "home_screen",
    status: "active",
    tokenGeneration: generation,
    refreshJti,
    createdAt: device.sessions?.[id]?.createdAt ?? now,
    lastSeenAt: now,
    expiresAt: new Date(
      Math.min(
        Date.parse(now) + 30 * 86400000,
        device.absoluteExpiresAt
          ? Date.parse(device.absoluteExpiresAt)
          : Infinity,
      ),
    ).toISOString(),
  };
}

/**
 * New contexts CAS the whole (bounded) map; existing contexts update only their
 * own slot, so two containers can rotate concurrently without losing tokens.
 * @param {string} tableName
 * @param {Record<string, any>} device
 * @param {string} id
 * @param {Record<string, any>} session
 * @param {string} [expectedJti]
 */
export function contextSessionWrite(
  tableName,
  device,
  id,
  session,
  expectedJti,
) {
  const current = device.sessions?.[id];
  const conditions = [
    "attribute_exists(pk)",
    "(attribute_not_exists(#status) OR #status = :active)",
  ];
  /** @type {Record<string, string>} */
  const names = { "#status": "status", "#sessions": "sessions", "#sid": id };
  /** @type {Record<string, any>} */
  const values = {
    ":active": "active",
    ":now": session.lastSeenAt,
    ":previousSeen":
      device.primaryLastSeenAt ?? device.lastSeenAt ?? session.lastSeenAt,
  };
  let expression;
  if (current) {
    conditions.push(
      "#sessions.#sid.tokenGeneration = :generation",
      "#sessions.#sid.#status = :active",
    );
    values[":generation"] = current.tokenGeneration;
    if (expectedJti !== undefined) {
      conditions.push("#sessions.#sid.refreshJti = :expectedJti");
      values[":expectedJti"] = expectedJti;
    }
    values[":session"] = session;
    expression =
      "SET #sessions.#sid = :session, lastSeenAt = :now, primaryLastSeenAt = if_not_exists(primaryLastSeenAt, :previousSeen)";
  } else {
    const sessions = Object.fromEntries(
      Object.entries(device.sessions ?? {}).filter(
        ([, value]) =>
          value.status === "active" && Date.parse(value.expiresAt) > Date.now(),
      ),
    );
    if (Object.keys(sessions).length >= CONTEXT_SESSION_LIMIT) return null;
    if (device.sessions) {
      conditions.push("#sessions = :previousSessions");
      values[":previousSessions"] = device.sessions;
    } else conditions.push("attribute_not_exists(#sessions)");
    conditions.push("tokenGeneration = :deviceGeneration");
    values[":deviceGeneration"] = device.tokenGeneration;
    values[":sessions"] = { ...sessions, [id]: session };
    delete names["#sid"];
    expression =
      "SET #sessions = :sessions, lastSeenAt = :now, primaryLastSeenAt = if_not_exists(primaryLastSeenAt, :previousSeen)";
  }
  return {
    Update: {
      TableName: tableName,
      Key: { pk: device.pk, sk: device.sk },
      UpdateExpression: expression,
      ConditionExpression: conditions.join(" AND "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
}

/** Public, credential-free session details. @param {Record<string, any>} device */
export function publicDeviceSessions(device) {
  const status =
    device.status && device.status !== "active" ? device.status : "active";
  return [
    {
      kind: device.primarySessionKind ?? "browser",
      status:
        status === "active"
          ? (device.primarySessionStatus ?? "active")
          : status,
      lastSeenAt: device.primaryLastSeenAt ?? device.lastSeenAt,
    },
    ...Object.values(device.sessions ?? {}).map((session) => ({
      kind: session.kind,
      status:
        status !== "active"
          ? status
          : session.status !== "active"
            ? session.status
            : Date.parse(session.expiresAt) <= Date.now()
              ? "expired"
              : "active",
      lastSeenAt: session.lastSeenAt,
    })),
  ];
}
