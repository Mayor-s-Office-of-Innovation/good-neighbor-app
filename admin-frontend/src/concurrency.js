/**
 * Map values while limiting the number of in-flight asynchronous operations.
 * Results preserve the input order. On failure, stop scheduling new values,
 * wait for in-flight operations to settle, then reject with the first error.
 *
 * @template T, U
 * @param {T[]} values
 * @param {number} limit
 * @param {(value: T, index: number) => Promise<U>} mapper
 * @returns {Promise<U[]>}
 */
export async function mapWithConcurrency(values, limit, mapper) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("concurrency_limit_must_be_positive");
  }

  /** @type {U[]} */
  const results = new Array(values.length);
  let nextIndex = 0;
  let failed = false;
  /** @type {unknown} */
  let firstError;

  async function worker() {
    while (!failed && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await mapper(values[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  if (failed) throw firstError;
  return results;
}
