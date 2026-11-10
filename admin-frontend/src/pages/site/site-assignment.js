/**
 * Find the active Program selected as a Site's Lead program.
 *
 * Provider and program relationships are independent. Selecting a program
 * never changes the Site provider implicitly.
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
