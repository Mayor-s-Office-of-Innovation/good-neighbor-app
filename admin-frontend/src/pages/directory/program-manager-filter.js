/** An explicit empty filter means All; only an absent filter uses the role default. */
export function defaultProgramManagerFilter(role, profile, requested) {
  if (requested !== null) return requested;
  return role === "compliance-manager"
    ? `id:${profile?.directoryUserId || "__unlinked__"}`
    : "";
}

/** Directory IDs avoid matching a different manager who happens to share a name. */
export function matchesProgramManager(site, selected) {
  if (!selected) return true;
  if (!selected.startsWith("id:"))
    return site.oversight?.cityProgramManager === selected;
  const id = selected.slice(3);
  return (site.complianceManagerIds || []).includes(id);
}
