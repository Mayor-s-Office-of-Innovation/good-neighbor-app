import { duplicateUiEnabled, onDuplicateUiChange } from "./feature-flags.js";
import { getDuplicateLinks } from "./api.js";
/** Independent, cancellable polling; no await on the analysis or guidance path.
 * @param {string[]} taskIds @param {(links: Map<string, Record<string, any>>) => void} onChange
 */
export function watchDuplicateIssues(taskIds, onChange) {
  if (!duplicateUiEnabled()) {
    return () => {};
  }
  let stopped = false,
    timer,
    previous = "",
    polls = 0;
  const started = Date.now();
  /** @type {Record<string, any>[]} */
  let lastRows = [];
  const ids = [...new Set(taskIds)].filter(Boolean);
  const unsubscribe = onDuplicateUiChange(() => {
    if (!duplicateUiEnabled()) {
      stopped = true;
      clearTimeout(timer);
      onChange(new Map());
      unsubscribe();
    }
  });
  const run = async () => {
    if (stopped || Date.now() - started > 15 * 60 * 1000 || !ids.length) {
      if (!stopped && lastRows.some((row) => row.state === "pending")) {
        onChange(
          new Map(
            lastRows.map((row) => [
              row.taskId,
              row.state === "pending" ? { ...row, state: "unavailable" } : row,
            ]),
          ),
        );
      }
      unsubscribe();
      return;
    }
    let delay = polls++ < 15 ? 2000 : 5000;
    try {
      if (!document.hidden) {
        const rows = [];
        for (let i = 0; i < ids.length && !stopped; i += 50) {
          const result = await getDuplicateLinks(ids.slice(i, i + 50));
          if (!result.enabled) {
            if (!stopped) onChange(new Map());
            stopped = true;
            unsubscribe();
            return;
          }
          rows.push(...result.issues);
        }
        if (stopped || !duplicateUiEnabled()) return;
        lastRows = rows;
        const key = JSON.stringify(rows);
        if (key !== previous) {
          previous = key;
          onChange(new Map(rows.map((row) => [row.taskId, row])));
        }
        if (rows.every((row) => row.state !== "pending")) delay = 30000;
      }
    } catch {
      delay = 15000;
    } // Retry separately; keep ordinary issue cards usable.
    if (!stopped) timer = setTimeout(run, delay);
  };
  void run();
  return () => {
    stopped = true;
    unsubscribe();
    clearTimeout(timer);
  };
}
