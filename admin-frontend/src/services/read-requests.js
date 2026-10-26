/** Share only simultaneous reads. Mutations invalidate the generation so a
 * read after a write never joins a request that started before that write. */
export function createReadRequests() {
  const pending = new Map();
  let generation = 0;
  return {
    invalidate() {
      generation++;
      pending.clear();
    },
    run(key, read) {
      const scoped = `${generation}:${key}`;
      if (pending.has(scoped)) return pending.get(scoped);
      const promise = Promise.resolve().then(read);
      pending.set(scoped, promise);
      const clear = () => {
        if (pending.get(scoped) === promise) pending.delete(scoped);
      };
      promise.then(clear, clear);
      return promise;
    },
  };
}
