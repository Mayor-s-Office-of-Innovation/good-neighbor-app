/**
 * Map values while limiting the number of in-flight asynchronous operations.
 * Results preserve the input order.
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

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return results;
}
