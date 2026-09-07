/*
  Minimal IndexedDB wrapper — the on-device source of truth for v1.
  No dependency: raw IndexedDB behind small promise helpers.

  Stores:
    - site   (keyPath 'id')   : single record, the site this device is bound to
    - draft  (out-of-line)    : the single in-progress check (key 'current'), so a
                                walk survives reload / app-close and can be resumed
                                from home. Photos ride inline as JPEG data-URLs.
    - review (out-of-line)    : the just-submitted check awaiting the reviewer's
                                Continue (key 'current'). Kept separate from `draft`
                                so home never offers to "Resume" it, and so the
                                assessment envelope + findings + photos survive a
                                reload — otherwise the results screen would fall back
                                to the read-only history path and tasks could never
                                mint. Cleared on Continue.

  Submitted checks live in the backend (DynamoDB), written on submit and read on
  load via services/api.js — the app is online-only for the submit/review path
  (docs/archive/frontend-api-wiring-plan.md). There is no local `checks` cache, no
  `synced` flag, and no sync queue, because offline is deferred to post-MVP.
*/

const DB_NAME = "conditions-reporter";
// v6: added the `review` store (just-submitted check awaiting Continue, kept out of
// `draft` so it isn't offered as a resumable walk). v5: dropped the unused `checks`
// store (submitted checks are backend-sourced; the store's only remaining writer was
// the retired ?demo seed). v4 added the `draft` store. Deletions/creations below are
// idempotent, so any older version converges.
const DB_VERSION = 6;

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
      // Clean slate: retired prototype/cutover stores are dropped on upgrade. The
      // `checks` store is gone — submitted checks are backend-sourced now.
      if (db.objectStoreNames.contains("reports"))
        db.deleteObjectStore("reports");
      if (db.objectStoreNames.contains("tasks")) db.deleteObjectStore("tasks");
      if (db.objectStoreNames.contains("checks"))
        db.deleteObjectStore("checks");
      // Out-of-line key: the check keeps its own generated `id`, and there is only
      // ever one active draft, stored under the fixed key "current".
      if (!db.objectStoreNames.contains("draft")) {
        db.createObjectStore("draft");
      }
      // Same shape as `draft`: a single submitted check under key "current", held
      // only until the reviewer hits Continue.
      if (!db.objectStoreNames.contains("review")) {
        db.createObjectStore("review");
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
  // meta may carry the onboarding code (identity provenance) and, once device
  // auth lands (services/devices.js), the device session (deviceId, token,
  // refreshToken, tokenExpiresAt, tokenGeneration). id/name/boundAt are
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
export async function saveSiteSettings(settings = {}) {
  const current = (await getSite()) || { id: "current", name: "Your site" };
  const record = {
    ...current,
    ...settings,
    id: "current",
    name: String(settings.name || current.name || "Your site").trim(),
  };
  await tx("site", "readwrite", (os) => os.put(record));
  return record;
}
export async function saveSitePlaces(places, meta = {}) {
  return saveSiteSettings({
    ...meta,
    places: Array.isArray(places) ? places : [],
  });
}
export async function clearSite() {
  return tx("site", "readwrite", (os) => os.delete("current"));
}

/**
 * Persist a refreshed device session onto the existing site record (Option 4
 * device auth). Merge-only: identity fields (id/name/boundAt) stay untouched;
 * only the token fields are replaced. Returns the updated record.
 * @param {{ deviceId: string, token: string, refreshToken: string, expiresIn: number, tokenGeneration: number }} session
 */
export async function updateSiteSession({
  deviceId,
  token,
  refreshToken,
  expiresIn,
  tokenGeneration,
}) {
  const current = await getSite();
  if (!current) throw new Error("cannot store a token without a bound site");
  const record = {
    ...current,
    deviceId,
    token,
    refreshToken,
    tokenGeneration,
    tokenExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
  await tx("site", "readwrite", (os) => os.put(record));
  return record;
}

function draftKey(flowType) {
  return flowType ? `flow:${flowType}` : "current";
}

/* ---- draft (resumable in-progress checks, keyed by flow + current) ---- */
export async function getDraft(flowType) {
  return tx("draft", "readonly", (os) =>
    reqToPromise(os.get(draftKey(flowType))),
  );
}
export async function saveDraft(check) {
  await tx("draft", "readwrite", (os) => {
    os.put(check, "current");
    if (check?.flowType) os.put(check, draftKey(check.flowType));
  });
  return check;
}

async function deleteDraftIfMatches(os, key, checkId) {
  if (!checkId) {
    os.delete(key);
    return;
  }
  const saved = await reqToPromise(os.get(key));
  if (saved?.id === checkId) {
    os.delete(key);
  }
}

/**
 * Clear the resumable draft, optionally only if it still belongs to one check.
 * @param {string | { flowType?: string, checkId?: string } | undefined} flowOrOpts
 * @param {string} [maybeCheckId]
 */
export async function clearDraft(flowOrOpts, maybeCheckId) {
  const flowType =
    flowOrOpts && typeof flowOrOpts === "object"
      ? flowOrOpts.flowType
      : flowOrOpts;
  const checkId =
    flowOrOpts && typeof flowOrOpts === "object"
      ? flowOrOpts.checkId
      : maybeCheckId;
  return tx("draft", "readwrite", async (os) => {
    await deleteDraftIfMatches(os, draftKey(flowType), checkId);
    if (!flowType) {
      await deleteDraftIfMatches(os, "current", checkId);
    }
  });
}

/* ---- review (single just-submitted check awaiting Continue, key 'current') ---- */
export async function getReview() {
  return tx("review", "readonly", (os) => reqToPromise(os.get("current")));
}
export async function saveReview(check) {
  await tx("review", "readwrite", (os) => os.put(check, "current"));
  return check;
}
export async function clearReview() {
  return tx("review", "readwrite", (os) => os.delete("current"));
}

export async function resetLocalAppState() {
  await Promise.all([
    tx("site", "readwrite", (os) => os.clear()),
    tx("draft", "readwrite", (os) => os.clear()),
    tx("review", "readwrite", (os) => os.clear()),
  ]);
}
