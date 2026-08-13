/*
  Minimal IndexedDB wrapper — the on-device source of truth for v1.
  No dependency: raw IndexedDB behind small promise helpers.

  Stores:
    - site   (keyPath 'id')   : single record, the site this device is bound to
    - checks (keyPath 'id')   : submitted perimeter checks + their findings

  A submitted check record is self-contained for v1 (its sides/items summary and
  findings live on the record) — deliberately NOT normalized into separate item/
  finding stores yet. The normalized schema is reworked against the backend at
  migration (see docs/take5-plan.md: "keep it light — don't over-build the DB").

  Records except 'site' carry siteId + synced:false so a later sync layer drops in
  without touching the UI.
*/

const DB_NAME = "conditions-reporter";
const DB_VERSION = 2; // v2: dropped prototype reports/tasks stores, added checks

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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
