// Overview and Site pages reload on every filter or period change, so an older
// reply can land after a newer one; only the latest load may draw.

export class LatestLoad {
  generation = 0;
  /** @type {AbortController | null} */
  controller = null;

  /** Aborts the load before it. @returns {{ signal: AbortSignal, current: () => boolean }} */
  start() {
    const mine = ++this.generation;
    this.controller?.abort();
    this.controller = new AbortController();
    return {
      signal: this.controller.signal,
      current: () => mine === this.generation,
    };
  }

  /** The latest load's signal, for requests that belong to it. */
  get signal() {
    return this.controller?.signal;
  }

  abort() {
    this.controller?.abort();
  }
}

/**
 * A newer load replaced this one, so its error is no longer the page's to show.
 * @param {unknown} err
 * @param {() => boolean} current
 */
export const superseded = (err, current) =>
  !current() || /** @type {any} */ (err)?.name === "AbortError";
