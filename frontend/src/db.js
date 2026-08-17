/*
  Minimal IndexedDB wrapper — the on-device source of truth for v1.
  No dependency: raw IndexedDB behind small promise helpers.

  Stores:
    - site   (keyPath 'id')   : single record, the site this device is bound to
    - checks (keyPath 'id')   : submitted perimeter checks + their findings
    - draft  (out-of-line)    : the single in-progress check (key 'current'), so a
                                walk survives reload / app-close and can be resumed
                                from home. Photos ride inline as JPEG data-URLs.

  Submitted checks now live in the backend (DynamoDB), written on submit and read
  on load via services/api.js — the app is online-only for the submit/review path
  (docs/archive/frontend-api-wiring-plan.md). The local `checks` store is retained only as
  demo/seed scaffolding (demo/seed.js) and is not on the submit path; there is no
  `synced` flag or sync queue, because offline is deferred to post-MVP.
*/

const DB_NAME = "conditions-reporter";
// v4: `draft` store. (Bumped past 3 to force onupgradeneeded to re-run for anyone
// whose DB recorded v3 during development before the draft store landed — the
// creation below is idempotent, so a fresh install and any older version converge.)
const DB_VERSION = 4;

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("site")) {
        db.createObjectStore("site", { keyPath: "id" });
      }
      // Clean slate: the old two-page prototype's stores are gone in v1.
      if (db.objectStoreNames.contains("reports"))
        db.deleteObjectStore("reports");
      if (db.objectStoreNames.contains("tasks")) db.deleteObjectStore("tasks");
      if (!db.objectStoreNames.contains("checks")) {
        const s = db.createObjectStore("checks", { keyPath: "id" });
        s.createIndex("bySite", "siteId");
        s.createIndex("bySubmittedAt", "submittedAt");
      }
      // Out-of-line key: the check keeps its own generated `id`, and there is only
      // ever one active draft, stored under the fixed key "current".
      if (!db.objectStoreNames.contains("draft")) {
        db.createObjectStore("draft");
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // If another tab later requests a newer version, don't wedge its upgrade —
      // close this connection so the version change can proceed.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    // A stale connection in another tab is holding the old version open. Surface it
    // rather than hanging silently; the versionchange handler above prevents it.
    req.onblocked = () =>
      reject(
        new Error(
          "IndexedDB upgrade blocked — close other tabs of this app and reload.",
        ),
      );
  });
  return _dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const os = t.objectStore(store);
        let result;
        Promise.resolve(fn(os)).then((r) => {
          result = r;
        });
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function newId() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return (
    "id-" +
    Math.abs(Math.floor(performance.now() * 1000)).toString(36) +
    "-" +
    performance.now().toString(36)
  );
}

/* ---- site (device binding) ---- */
export async function getSite() {
  return tx("site", "readonly", (os) => reqToPromise(os.get("current")));
}
export async function setSite(name, meta = {}) {
  // meta may carry the onboarding code (identity provenance); id/name/boundAt are
  // authoritative and can't be clobbered by it.
  const record = {
    ...meta,
    id: "current",
    name: name.trim(),
    boundAt: new Date().toISOString(),
  };
  await tx("site", "readwrite", (os) => os.put(record));
  return record;
}
export async function clearSite() {
  return tx("site", "readwrite", (os) => os.delete("current"));
}

/* ---- checks ---- */
export async function addCheck(check) {
  await tx("checks", "readwrite", (os) => os.put(check));
  return check;
}
export async function getChecksForSite(siteId) {
  return tx("checks", "readonly", (os) =>
    reqToPromise(os.index("bySite").getAll(siteId)),
  );
}
export async function clearChecks() {
  return tx("checks", "readwrite", (os) => os.clear());
}

/* ---- draft (single resumable in-progress check, key 'current') ---- */
export async function getDraft() {
  return tx("draft", "readonly", (os) => reqToPromise(os.get("current")));
}
export async function saveDraft(check) {
  await tx("draft", "readwrite", (os) => os.put(check, "current"));
  return check;
}
export async function clearDraft() {
  return tx("draft", "readwrite", (os) => os.delete("current"));
}
