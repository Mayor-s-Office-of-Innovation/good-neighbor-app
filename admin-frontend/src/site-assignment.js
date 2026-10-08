/**
 * Find the active Program selected as a Site's Lead program.
 *
 * A Site may move between Providers when its Lead program changes, so callers
 * must derive the Provider from the selected Program instead of retaining the
 * Site's previous Provider.
 *
 * @param {Array<{ programId?: string, providerId?: string, status?: string }>} programs
 * @param {string} leadProgramId
 * @returns {{ programId?: string, providerId?: string, status?: string } | null}
 */
export function selectedLeadProgram(programs, leadProgramId) {
  return (
    programs.find(
      (program) =>
        program.programId === leadProgramId && program.status !== "inactive",
    ) ?? null
  );
}
