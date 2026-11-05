/** Resume a partially created person only for the same site, program, and form values.
 * @param {Map<string, any>} pending
 * @param {{siteId:string, programId:string, values:Record<string,any>}} operation
 * @param {{createProgramUser:Function, createManagerMembership:Function}} api
 */
export async function createAndAssignManager(pending, operation, api) {
  const { siteId, programId, values } = operation;
  const key = JSON.stringify([siteId, programId, values]);
  let user = pending.get(key);
  if (!user) {
    user = (await api.createProgramUser(programId, values)).user;
    pending.set(key, user);
  }
  await api.createManagerMembership(
    siteId,
    `${user.firstName} ${user.lastName}`.trim(),
    user.email,
    programId,
    user.userId,
  );
  pending.delete(key);
  return user;
}
