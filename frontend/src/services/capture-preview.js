import {
  getCaptureMedia,
  getLocalCapturePreview,
  cacheLocalCapturePreview,
} from "../db.js";

const pending = new Set();
const attempted = new Set();
let running = false;
let disabled = false;
let worker;
let cancel;

/** Queue keys, never a collection of full-size Files or decoded images. @param {string} key */
export function queueCapturePreview(key) {
  if (
    !key ||
    pending.size >= 100 ||
    disabled ||
    attempted.has(key) ||
    typeof Worker !== "function"
  )
    return;
  attempted.add(key);
  if (attempted.size > 100) attempted.delete(attempted.values().next().value);
  pending.add(key);
  void drain();
}

function render(original) {
  return new Promise((resolve, reject) => {
    worker ||= new Worker(
      new URL("./capture-preview.worker.js", import.meta.url),
      { type: "module", name: "capture-preview" },
    );
    const finish = (result) => {
      clearTimeout(timer);
      cancel = null;
      resolve(result);
    };
    const timer = setTimeout(() => {
      worker?.terminate();
      worker = null;
      finish(null);
    }, 5000);
    cancel = () => {
      worker?.terminate();
      worker = null;
      finish(null);
    };
    worker.onmessage = ({ data }) => {
      if (data.unsupported) {
        disabled = true;
        pending.clear();
      }
      finish(data.preview instanceof Blob ? data.preview : null);
    };
    worker.onerror = () => {
      worker?.terminate();
      worker = null;
      finish(null);
    };
    try {
      worker.postMessage({ original });
    } catch (error) {
      clearTimeout(timer);
      cancel = null;
      reject(error);
    }
  });
}

async function drain() {
  if (running || disabled || document.hidden) return;
  running = true;
  try {
    while (pending.size && !document.hidden && !disabled) {
      const key = pending.values().next().value;
      pending.delete(key);
      try {
        if (await getLocalCapturePreview(key)) continue;
        let media = await getCaptureMedia(key);
        if (!media?.original || media.thumbnail) continue;
        if (document.hidden) {
          pending.add(key);
          break;
        }
        const result = render(media.original);
        media = null;
        const preview = await result;
        if (
          preview &&
          preview.size <= 256 * 1024 &&
          (await cacheLocalCapturePreview(key, preview))
        )
          window.dispatchEvent(
            new CustomEvent("capture-preview-ready", { detail: { key } }),
          );
        if (document.hidden) {
          attempted.delete(key);
          pending.add(key);
        }
      } catch {
        // Preview failure must never block admission, upload, or offline recovery.
      }
    }
  } finally {
    worker?.terminate();
    worker = null;
    running = false;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) cancel?.();
  else void drain();
});
window.addEventListener("pagehide", () => cancel?.());
