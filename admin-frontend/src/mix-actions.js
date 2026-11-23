// Lets each page element take the methods in its own *.actions.js file.

/**
 * Copy each action onto the class, non-enumerable like a class method. Throws on a
 * name it already has, even an inherited one like focus(), so none is silently replaced.
 * @param {{ prototype: object, name: string }} target
 * @param {...object} actionSets
 */
export function mixActions(target, ...actionSets) {
  for (const actions of actionSets)
    for (const [name, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(actions),
    )) {
      if (name in target.prototype)
        throw new Error(`${target.name} already has ${name}`);
      Object.defineProperty(target.prototype, name, {
        ...descriptor,
        enumerable: false,
      });
    }
}
