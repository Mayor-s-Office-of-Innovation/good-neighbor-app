/**
 * Attach the one-time secret URL returned by grant creation to the matching
 * public grant row for the lifetime of the current admin view. The backend
 * intentionally never persists or re-lists this secret.
 * @param {Array<Record<string, unknown>>} grants
 * @param {{ grant?: { grantId?: string }, enrollmentUrl?: string } | null | undefined} created
 * @returns {Array<Record<string, unknown>>}
 */
export function attachCreatedEnrollmentUrl(grants, created) {
  const grantId = String(created?.grant?.grantId || "");
  const enrollmentUrl = String(created?.enrollmentUrl || "");
  if (!grantId || !enrollmentUrl) return grants;
  return grants.map((grant) =>
    grant.grantId === grantId ? { ...grant, enrollmentUrl } : grant,
  );
}

/**
 * Copy a newly issued enrollment URL using the browser clipboard API.
 * @param {string} enrollmentUrl
 * @param {{ writeText?: (value: string) => Promise<void> } | undefined} clipboard
 * @returns {Promise<void>}
 */
export async function copyEnrollmentUrl(
  enrollmentUrl,
  clipboard = globalThis.navigator?.clipboard,
) {
  if (!enrollmentUrl || !clipboard?.writeText) {
    throw new Error("clipboard_unavailable");
  }
  await clipboard.writeText(enrollmentUrl);
}
