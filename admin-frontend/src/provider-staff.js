import { mapWithConcurrency } from "./concurrency.js";

/** Load only staff affiliated with the chosen provider. */
export async function loadProviderStaff(providerId, programs, api) {
  const [provider, programStaff] = await Promise.all([
    api.listProviderManagers(providerId),
    mapWithConcurrency(
      programs.filter(
        (p) => p.providerId === providerId && p.status !== "inactive",
      ),
      4,
      async (program) => ({
        program,
        data: await api.getProgram(program.programId),
      }),
    ),
  ]);
  return [
    ...(provider.managers || [])
      .filter((person) => person.status === "active")
      .map((person) => ({
        person,
        reference: { providerManagerId: person.membershipId },
      })),
    ...programStaff.flatMap(({ program, data }) =>
      (data.users || [])
        .filter((person) => person.status === "active")
        .map((person) => ({
          person,
          reference: { programId: program.programId, userId: person.userId },
        })),
    ),
  ];
}
