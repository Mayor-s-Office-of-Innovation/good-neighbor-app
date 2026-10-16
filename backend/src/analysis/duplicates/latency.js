import { performance } from "node:perf_hooks";
/**
 * Evidence-free timing fields for the isolated duplicate pipeline.
 * @returns {{add:(name:string,milliseconds:number)=>void,mark:(name:string)=>void,snapshot:()=>Record<string,number>}}
 */
export function latencyTracker() {
  const started = performance.now();
  /** @type {Record<string,number>} */ const durations = {};
  return {
    /**
     * @param {string} name
     * @param {number} milliseconds
     */
    add(name, milliseconds) {
      durations[name] = (durations[name] ?? 0) + Math.max(0, milliseconds);
    },
    /** @param {string} name */
    mark(name) {
      durations[name] = Math.round(performance.now() - started);
    },
    snapshot() {
      return { ...durations, totalMs: Math.round(performance.now() - started) };
    },
  };
}
