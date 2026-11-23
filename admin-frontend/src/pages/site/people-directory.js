/** Preserve legacy URLs as aliases; assignments are independent of affiliation. */
export function peopleDirectory(
  people,
  memberships,
  programs,
  providers,
  legacy = [],
) {
  const canonical = people
    .filter(
      (person) =>
        person.siteManager ||
        memberships.some((m) => m.personId === person.personId),
    )
    .map((person) => {
      const sources = person.sources || [];
      const userIds = sources
        .filter((s) => s.sk.startsWith("USER#"))
        .map((s) => s.sk.slice(5));
      return {
        ...person,
        userId: person.personId,
        legacyUserIds: userIds,
        programId: person.primaryProgramId || "",
        providerId: person.primaryProviderId || "",
        programName:
          programs.find((p) => p.programId === person.primaryProgramId)?.name ||
          "",
        providerName:
          providers.find((p) => p.providerId === person.primaryProviderId)
            ?.name || "",
        assignedSites: memberships.filter(
          (m) => m.personId === person.personId || userIds.includes(m.userId),
        ),
      };
    });
  const known = new Set(canonical.flatMap((p) => p.legacyUserIds));
  return [...canonical, ...legacy.filter((p) => !known.has(p.userId))].sort(
    (a, b) =>
      `${a.firstName} ${a.lastName}`.localeCompare(
        `${b.firstName} ${b.lastName}`,
      ),
  );
}
