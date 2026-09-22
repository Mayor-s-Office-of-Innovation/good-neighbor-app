/*
  Minimal IndexedDB wrapper — the on-device source of truth for v1.
  No dependency: raw IndexedDB behind small promise helpers.

  Stores:
    - site   (keyPath 'id')   : current binding plus one saved binding per site
    - draft  (out-of-line)    : the in-progress check (per-site keys), so a
                                walk survives reload / app-close and can be resumed
                                from home. Photos ride inline as JPEG data-URLs.
    - review (out-of-line)    : the just-submitted check awaiting the reviewer's
                                Continue (per-site key). Kept separate from `draft`
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
      // Out-of-line key: the check keeps its own generated `id`; drafts are
      // keyed by site and flow, with legacy "current" entries still readable.
      if (!db.objectStoreNames.contains("draft")) {
        db.createObjectStore("draft");
      }
      // Same shape as `draft`: the submitted check for each site is held
      // until the reviewer hits Continue.
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

const bindingKey = (siteId) => `bound:${siteId}`;

/** All site sessions saved on this device, including a legacy current-only binding. */
export async function listBoundSites() {
  const records = await tx("site", "readonly", (os) =>
    reqToPromise(os.getAll()),
  );
  const bindings = records.filter((record) =>
    String(record.id || "").startsWith("bound:"),
  );
  const current = records.find((record) => record.id === "current");
  if (
    current?.siteId &&
    !bindings.some((record) => record.siteId === current.siteId)
  ) {
    bindings.push({ ...current, id: bindingKey(current.siteId) });
  }
  return bindings;
}

/** Select an already registered site without using its setup code again. */
export async function activateSiteBinding(siteId) {
  const current = await getSite();
  if (current?.siteId === siteId) return current;
  const saved = await tx("site", "readonly", (os) =>
    reqToPromise(os.get(bindingKey(siteId))),
  );
  if (!saved?.token || !saved?.refreshToken) return null;
  const selected = { ...saved, id: "current" };
  await tx("site", "readwrite", (os) => {
    if (current?.siteId) {
      os.put({ ...current, id: bindingKey(current.siteId) });
    }
    os.put(selected);
  });
  return selected;
}

export async function setSite(name, meta = {}) {
  // meta may carry the onboarding code (identity provenance) and, once device
  // auth lands (services/devices.js), the device session (deviceId, token,
  // refreshToken, tokenExpiresAt, tokenGeneration). id/name/boundAt are
  // authoritative and can't be clobbered by it.
  /** @type {Record<string, any>} */
  const record = {
    ...meta,
    id: "current",
    name: name.trim(),
    boundAt: new Date().toISOString(),
  };
  const previous = await getSite();
  await tx("site", "readwrite", (os) => {
    if (previous?.siteId && previous.siteId !== record.siteId) {
      os.put({ ...previous, id: bindingKey(previous.siteId) });
    }
    os.put(record);
    if (record.siteId) os.put({ ...record, id: bindingKey(record.siteId) });
  });
  return record;
}
/**
 * Fields owned by the device binding (setSite at registration) and the session
 * (updateSiteSession). Site *settings* — the GET /v1/site response callers
 * spread in — describe the site's configuration, never its identity, so these
 * keys are dropped from `settings` whenever the stored record already has
 * them. Without this guard a server response resolved for the wrong tenant
 * (e.g. the demo fallback) rewrote `siteId` and orphaned the device.
 */
const SITE_BINDING_FIELDS = [
  "id",
  "siteId",
  "providerSiteId",
  "code",
  "deviceId",
  "token",
  "refreshToken",
  "tokenExpiresAt",
  "tokenGeneration",
  "boundAt",
];

/**
 * Read the `custom:siteId` claim out of a stored device access token. No
 * signature check — the server verified it when it was minted, and the client
 * only uses the value to sanity-check what the server reports back.
 * @param {unknown} token
 * @returns {string} the claim, or "" when the token is absent or unreadable
 */
export function siteIdFromToken(token) {
  if (typeof token !== "string") return "";
  const payload = token.split(".")[1];
  if (!payload) return "";
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const claim = JSON.parse(json)?.["custom:siteId"];
    return typeof claim === "string" ? claim : "";
  } catch {
    return "";
  }
}

/**
 * @param {Record<string, any>} [settings] site settings to merge (typically the
 *   GET /v1/site response); binding/session keys are ignored, see above
 */
export async function saveSiteSettings(settings = {}) {
  const current = (await getSite()) || { id: "current", name: "Your site" };
  const incoming = { ...settings };
  for (const key of SITE_BINDING_FIELDS) {
    const bound = /** @type {Record<string, unknown>} */ (current)[key];
    if (bound !== undefined && bound !== null && bound !== "") {
      delete incoming[key];
    }
  }
  // Self-heal: the access token's `custom:siteId` claim is the binding the
  // server actually enforces. A server-reported siteId that matches it may
  // replace a stale local value (devices whose record was rewritten to the
  // demo partition before the backend failed closed recover on next load).
  const claimed = siteIdFromToken(current.token);
  if (claimed && settings.siteId === claimed) {
    incoming.siteId = claimed;
  }
  const record = {
    ...current,
    ...incoming,
    id: "current",
    name: String(settings.name || current.name || "Your site").trim(),
  };
  await tx("site", "readwrite", (os) => {
    os.put(record);
    if (record.siteId) os.put({ ...record, id: bindingKey(record.siteId) });
  });
  return record;
}
export async function clearSite() {
  return tx("site", "readwrite", (os) => os.delete("current"));
}

/**
 * Explicit sign-out clears every saved site binding and local check artifact.
 * Ordinary site switching retains each site's independently keyed draft and
 * review record so the user can safely return to an unfinished check.
 * @returns {Promise<void>}
 */
export async function clearSiteSession() {
  await resetLocalAppState();
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
  await tx("site", "readwrite", (os) => {
    os.put(record);
    if (record.siteId) os.put({ ...record, id: bindingKey(record.siteId) });
  });
  return record;
}

function draftKey(flowType, siteId = "") {
  const key = flowType ? `flow:${flowType}` : "current";
  return siteId ? `site:${siteId}:${key}` : key;
}

/* ---- draft (resumable in-progress checks, keyed by flow + current) ---- */
export async function getDraft(flowType) {
  const siteId = (await getSite())?.siteId || "";
  const scoped = await tx("draft", "readonly", (os) =>
    reqToPromise(os.get(draftKey(flowType, siteId))),
  );
  if (scoped || !siteId) return scoped;
  const legacy = await tx("draft", "readonly", (os) =>
    reqToPromise(os.get(draftKey(flowType))),
  );
  return legacy?.siteId === siteId ? legacy : null;
}
export async function saveDraft(check) {
  const siteId = check?.siteId || (await getSite())?.siteId || "";
  await tx("draft", "readwrite", (os) => {
    os.put(check, draftKey(undefined, siteId));
    if (check?.flowType) os.put(check, draftKey(check.flowType, siteId));
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
 * @param {string | { flowType?: string, checkId?: string, siteId?: string } | undefined} flowOrOpts
 * @param {string} [maybeCheckId]
 */
export async function clearDraft(flowOrOpts, maybeCheckId) {
  const siteId =
    (typeof flowOrOpts === "object" && flowOrOpts?.siteId) ||
    (await getSite())?.siteId ||
    "";
  const flowType =
    flowOrOpts && typeof flowOrOpts === "object"
      ? flowOrOpts.flowType
      : flowOrOpts;
  const checkId =
    flowOrOpts && typeof flowOrOpts === "object"
      ? flowOrOpts.checkId
      : maybeCheckId;
  return tx("draft", "readwrite", async (os) => {
    await deleteDraftIfMatches(os, draftKey(flowType, siteId), checkId);
    if (siteId) {
      const legacy = await reqToPromise(os.get(draftKey(flowType)));
      if (legacy?.siteId === siteId) {
        await deleteDraftIfMatches(os, draftKey(flowType), checkId);
      }
    }
    if (!flowType) {
      await deleteDraftIfMatches(os, draftKey(undefined, siteId), checkId);
    }
  });
}

/* ---- review (single just-submitted check awaiting Continue, key 'current') ---- */
export async function getReview() {
  const siteId = (await getSite())?.siteId || "";
  const scoped = await tx("review", "readonly", (os) =>
    reqToPromise(os.get(draftKey(undefined, siteId))),
  );
  if (scoped || !siteId) return scoped;
  const legacy = await tx("review", "readonly", (os) =>
    reqToPromise(os.get("current")),
  );
  return legacy?.siteId === siteId ? legacy : null;
}
export async function saveReview(check) {
  const siteId = check?.siteId || (await getSite())?.siteId || "";
  await tx("review", "readwrite", (os) =>
    os.put(check, draftKey(undefined, siteId)),
  );
  return check;
}
/** @param {string} [owningSiteId] */
export async function clearReview(owningSiteId) {
  const siteId = owningSiteId || (await getSite())?.siteId || "";
  return tx("review", "readwrite", async (os) => {
    os.delete(draftKey(undefined, siteId));
    if (siteId) {
      const legacy = await reqToPromise(os.get("current"));
      if (legacy?.siteId === siteId) os.delete("current");
    }
  });
}

export async function resetLocalAppState() {
  await Promise.all([
    tx("site", "readwrite", (os) => os.clear()),
    tx("draft", "readwrite", (os) => os.clear()),
    tx("review", "readwrite", (os) => os.clear()),
  ]);
}
