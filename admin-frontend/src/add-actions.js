/**
 * Throws on a name AdminApp already has, even an inherited one like focus(),
 * so a page action can't silently replace it.
 * @param {object} prototype
 * @param {object[]} actionsList
 * @returns {void}
 */
export function addActions(prototype, actionsList) {
  for (const actions of actionsList) {
    for (const [name, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(actions),
    )) {
      if (name in prototype) throw new Error(`AdminApp already has ${name}`);
      Object.defineProperty(prototype, name, {
        ...descriptor,
        enumerable: false,
      });
    }
  }
}
