import { completeTask } from "./api.js";
import { getSite } from "../db.js";
import { showActionSaveErrorToast } from "../state/toasts.js";

// A tab-scoped handoff receipt, not a general offline queue. No credentials or
// phone numbers are stored. sessionStorage survives a phone-app handoff/reload.
const PREFIX = "gnp:phone-completion:";
const active = new Map();
const receipts = new Map();
const errors = new Map();

function keyFor(receipt) {
  return (
    PREFIX +
    encodeURIComponent(receipt.siteId) +
    ":" +
    encodeURIComponent(receipt.taskId)
  );
}

function remember(receipt) {
  const key = keyFor(receipt);
  receipts.set(key, receipt);
  try {
    sessionStorage.setItem(key, JSON.stringify(receipt));
  } catch {
    // Storage restrictions must never prevent an emergency call. Keep the
    // receipt in memory so returning to this page can still retry the save.
  }
}

/** Persist synchronously, before either async preparation or native handoff. */
export function savePhoneCompletion(taskId, siteId) {
  if (!taskId || !siteId)
    return Promise.reject(new Error("Missing phone completion context"));
  const receipt = { taskId, siteId };
  remember(receipt);
  return save(receipt);
}

function save(receipt) {
  const key = keyFor(receipt);
  if (active.has(key)) return active.get(key);
  const attempt = (async () => {
    try {
      const result = await completeTask(
        receipt.taskId,
        { completionMethod: "manual" },
        {
          originSiteId: receipt.siteId,
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!["in_progress", "completed"].includes(result?.task?.status)) {
        throw new Error("Phone completion was not confirmed");
      }
      receipts.delete(key);
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* retry is idempotent */
      }
      errors.get(key)?.close();
      errors.delete(key);
      return result;
    } catch (error) {
      if ((await getSite().catch(() => null))?.siteId === receipt.siteId)
        showPhoneCompletionError(receipt.taskId, receipt.siteId);
      throw error;
    } finally {
      active.delete(key);
    }
  })();
  active.set(key, attempt);
  return attempt;
}

/** Reattach save-only recovery after a card repaint without redialing.
 * @param {string} taskId
 * @param {string} siteId
 * @param {Element | null} [target]
 */
export function showPhoneCompletionError(taskId, siteId, target) {
  const key = keyFor({ taskId, siteId });
  if (!receipts.has(key)) return;
  errors.get(key)?.close();
  const retry = () => recoverPhoneCompletions();
  errors.set(
    key,
    target
      ? showActionSaveErrorToast(retry, target)
      : showActionSaveErrorToast(retry),
  );
}

/** Retry saves only for the active site; recovery never opens the dialer. */
export async function recoverPhoneCompletions() {
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      try {
        const receipt = JSON.parse(sessionStorage.getItem(key));
        if (
          typeof receipt?.siteId === "string" &&
          typeof receipt?.taskId === "string" &&
          keyFor(receipt) === key
        )
          receipts.set(key, receipt);
      } catch {
        /* ignore malformed receipts */
      }
    }
  } catch {
    /* storage may be disabled; retain the in-memory receipts */
  }
  try {
    const site = await getSite();
    for (const [key, receipt] of receipts) {
      if (receipt.siteId !== site?.siteId || active.has(key)) continue;
      await save(receipt);
      window.dispatchEvent(new CustomEvent("phonecompletionsaved"));
    }
  } catch {
    /* save() exposes a persistent retry action */
  }
}

/** Install once per app shell, including recovery after a page restoration. */
export function startPhoneCompletionRecovery() {
  const resume = () => {
    if (document.visibilityState !== "hidden") void recoverPhoneCompletions();
  };
  window.addEventListener("pageshow", resume);
  window.addEventListener("online", resume);
  document.addEventListener("visibilitychange", resume);
  resume();
  return () => {
    window.removeEventListener("pageshow", resume);
    window.removeEventListener("online", resume);
    document.removeEventListener("visibilitychange", resume);
  };
}

/** Preserve failed save recovery when a refreshed worklist replaces its cards. */
export function restorePhoneCompletionErrors(host, siteId) {
  for (const [key, receipt] of receipts) {
    if (!errors.has(key) || receipt.siteId !== siteId) continue;
    const card = [...host.querySelectorAll("[data-task-id]")].find(
      (node) => node.getAttribute("data-task-id") === receipt.taskId,
    );
    if (card) showPhoneCompletionError(receipt.taskId, receipt.siteId, card);
  }
}
