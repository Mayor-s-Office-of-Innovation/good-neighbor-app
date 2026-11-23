export const test = { extend: () => ({}) };
export function expect() {
  throw new Error("Playwright's expect is not available in unit tests");
}
