import { inspect } from "node:util";

/**
 * A failed assertion prints its values; a happy-dom node's object graph is huge,
 * and printing it once took a test process past 80 GB. Print a short tag instead.
 * @param {any} window
 */
export function quietInspect(window) {
  quiet(window.Node.prototype, function () {
    return `<${this.nodeName?.toLowerCase()}${this.id ? `#${this.id}` : ""}>`;
  });
  for (const prototype of [window.Window.prototype, window.Event.prototype])
    quiet(prototype, function () {
      return `[${this.constructor.name}]`;
    });
}

/**
 * happy-dom windows share prototypes, so a second window's call finds them done.
 * @param {any} prototype
 * @param {(this: any) => string} value
 */
function quiet(prototype, value) {
  if (Object.hasOwn(prototype, inspect.custom)) return;
  Object.defineProperty(prototype, inspect.custom, { value });
}
