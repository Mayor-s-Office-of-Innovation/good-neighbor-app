import { mapWithConcurrency } from "./concurrency.js";

export function providerManagerPath(providerId, membershipId) {
  return `/provider-managers/${encodeURIComponent(providerId)}/${encodeURIComponent(membershipId)}`;
}

export async function loadProviderManagerDirectory(providers, api) {
  const groups = await mapWithConcurrency(
    providers.filter((p) => p.status !== "inactive"),
    3,
    async (provider) => {
      const result = await api.listProviderManagers(provider.providerId);
      return (result.managers || []).map((manager) => ({
        ...manager,
        providerId: provider.providerId,
        providerName: provider.name,
      }));
    },
  );
  const rows = groups.flat();
  return rows
    .filter(
      (row) =>
        !(
          row.status === "inactive" &&
          row.personId &&
          rows.some(
            (other) =>
              other.personId === row.personId && other.status === "active",
          )
        ),
    )
    .sort((a, b) =>
      `${a.firstName} ${a.lastName}`.localeCompare(
        `${b.firstName} ${b.lastName}`,
      ),
    );
}

/** Reload live enrollments before revoking; a failed run can retry remaining devices. */
export async function revokeProviderDevices(
  api,
  providerId,
  membershipId = "",
) {
  const { enrollments = [] } = await api.listProviderManagers(providerId);
  const active = enrollments.filter(
    (item) =>
      item.status !== "revoked" &&
      (!membershipId || item.membershipId === membershipId),
  );
  let removed = 0;
  for (const item of active) {
    try {
      await api.revokeProviderManagerEnrollment(providerId, item.enrollmentId);
      removed++;
    } catch (error) {
      // A concurrent revocation may already have removed this enrollment.
      if (error.message === "provider_manager_enrollment_not_found") continue;
      throw error;
    }
  }
  return removed;
}

/** Keep the manager record, invalidate membership access, then clean up enrolled devices. */
export async function removeProviderManagerAccess(
  api,
  providerId,
  membershipId,
) {
  await api.deactivateProviderManager(providerId, membershipId);
  await revokeProviderDevices(api, providerId, membershipId);
}
