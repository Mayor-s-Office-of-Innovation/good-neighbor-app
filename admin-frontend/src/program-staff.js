import { mapWithConcurrency } from "./concurrency.js";

/** Load active staff and their distinct active Site assignments from both record types.
 * @param {{ programId: string, users?: any[], sites?: any[] }} program
 * @param {{ getSite: Function }} api
 * @param {number} concurrency
 */
export async function loadProgramStaff(program, api, concurrency) {
  const sites = await mapWithConcurrency(
    (program.sites || []).filter((site) => site.status !== "inactive"),
    concurrency,
    async (site) => {
      const { items = [] } = await api.getSite(site.siteId);
      const meta = items.find((item) => item.sk === "#META");
      return {
        ...site,
        ...meta,
        assignments: items.filter(
          (item) =>
            item.status !== "inactive" &&
            (item.type === "siteUserAssignment" ||
              item.type === "managerMembership"),
        ),
      };
    },
  );
  return (program.users || [])
    .filter((user) => user.status !== "inactive")
    .map((user) => ({
      ...user,
      assignedSites: sites.filter(
        (site) =>
          site.status !== "inactive" &&
          site.leadProgramId === program.programId &&
          site.assignments.some(
            (assignment) =>
              assignment.userId === user.userId ||
              (!assignment.userId &&
                user.email &&
                String(assignment.email || "").toLowerCase() ===
                  String(user.email).toLowerCase()),
          ),
      ),
    }))
    .sort((a, b) =>
      `${a.firstName} ${a.lastName}`.localeCompare(
        `${b.firstName} ${b.lastName}`,
      ),
    );
}

/** Resolve legacy contact snapshots without guessing when multiple staff share an email.
 * @param {{ primaryContactUserId?: string, contact?: any, users?: any[] }} program
 */
export function primaryProgramStaffId(program) {
  if (program.primaryContactUserId) return program.primaryContactUserId;
  const email = String(program.contact?.email || "")
    .trim()
    .toLowerCase();
  const matches = (program.users || []).filter(
    (user) =>
      user.status !== "inactive" &&
      email &&
      String(user.email || "")
        .trim()
        .toLowerCase() === email,
  );
  return matches.length === 1 ? matches[0].userId : "";
}
