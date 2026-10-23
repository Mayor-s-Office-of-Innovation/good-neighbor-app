/** One person per Site, including older assignment-only records.
 * @param {any[]} assignments @param {any[]} memberships @param {any[]} users
 */
export function siteManagerRoster(assignments, memberships, users = []) {
  const active = memberships.filter((item) => item.status === "active");
  const roster = active.map((membership) => {
    const user =
      users.find(
        (item) => membership.personId && item.personId === membership.personId,
      ) ||
      (!membership.personId &&
        users.find(
          (item) =>
            item.userId === membership.userId ||
            (!membership.userId &&
              item.email &&
              item.email.toLowerCase() === membership.email?.toLowerCase()),
        ));
    return {
      ...membership,
      ...(user
        ? {
            userId: user.userId,
            programId: user.programId || membership.programId,
            email: user.email,
          }
        : {}),
      name: user
        ? `${user.firstName} ${user.lastName}`.trim()
        : membership.name,
    };
  });
  for (const assignment of assignments) {
    if (
      assignment.status === "inactive" ||
      active.some(
        (item) =>
          item.userId === assignment.userId ||
          (!item.userId &&
            assignment.email &&
            item.email?.toLowerCase() === assignment.email.toLowerCase()),
      )
    )
      continue;
    const user =
      users.find((item) => item.userId === assignment.userId) || assignment;
    if (user.status === "inactive") continue;
    roster.push({
      ...assignment,
      ...user,
      membershipId: `legacy:${assignment.userId}`,
      legacyAssignment: true,
      name: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
      status: "active",
      activeBindingCount: 0,
    });
  }
  return roster;
}
