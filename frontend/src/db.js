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
  `synced` flag for checks. Care submissions use separately namespaced review
  records to persist pending uploads and retries; no service worker is involved.
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
        const os = t.objectStore(Array.isArray(store) ? store[0] : store);
        let result;
        Promise.resolve()
          .then(() => fn(os, t))
          .then(
            (r) => {
              result = r;
            },
            (error) => {
              reject(error);
              try {
                t.abort();
              } catch {
                /* The request may already have aborted it. */
              }
            },
          );
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
  return tx("site", "readwrite", async (os) => {
    const current = await reqToPromise(os.get("current"));
    if (current?.siteId === siteId) return current;
    const saved = await reqToPromise(os.get(bindingKey(siteId)));
    if (!saved?.token || !saved?.refreshToken) return null;
    const selected = { ...saved, id: "current" };
    if (current?.siteId) {
      os.put({ ...current, id: bindingKey(current.siteId) });
    }
    os.put(selected);
    return selected;
  });
}

/**
 * The site-record fields a minted device session contributes. Registration,
 * enrollment, binding select, and the Home Screen handoff all store this one
 * shape; callers add their own provenance (code, providerSiteId) on top.
 * @param {{ deviceId: string, token: string, refreshToken: string, expiresIn: number, tokenGeneration: number, accessLevel?: string, bindingId?: string, physicalDeviceId?: string, absoluteExpiresAt?: string, site?: { siteId: string } }} session
 * @returns {Record<string, any>}
 */
export function bindingFromSession(session) {
  /** @type {Record<string, any>} */
  const fields = {
    siteId: session.site?.siteId,
    deviceId: session.deviceId,
    bindingId: session.bindingId,
    physicalDeviceId: session.physicalDeviceId,
    token: session.token,
    refreshToken: session.refreshToken,
    tokenExpiresAt: new Date(
      Date.now() + session.expiresIn * 1000,
    ).toISOString(),
    tokenGeneration: session.tokenGeneration,
    accessLevel: session.accessLevel,
    absoluteExpiresAt: session.absoluteExpiresAt,
  };
  for (const key of Object.keys(fields)) {
    if (fields[key] === undefined) delete fields[key];
  }
  return fields;
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
    localSessionId: crypto.randomUUID(),
  };
  await tx("site", "readwrite", async (os) => {
    const previous = await reqToPromise(os.get("current"));
    if (previous?.siteId && previous.siteId !== record.siteId) {
      os.put({ ...previous, id: bindingKey(previous.siteId) });
    }
    os.put(record);
    if (record.siteId) os.put({ ...record, id: bindingKey(record.siteId) });
  });
  return record;
}

/**
 * Persist server-created Site binding metadata without inventing local token
 * state. Selecting one later exchanges the current physical-device session
 * for that binding through `/device-bindings/select`.
 * @param {Array<{siteId:string,siteName:string,bindingId:string,accessLevel?:"general"|"manager"}>} bindings
 * @param {string} physicalDeviceId
 */
export async function saveDiscoveredBindings(bindings, physicalDeviceId) {
  if (!physicalDeviceId || !Array.isArray(bindings)) return;
  await tx("site", "readwrite", async (os) => {
    for (const binding of bindings) {
      if (!binding?.siteId || !binding.bindingId) continue;
      const id = bindingKey(binding.siteId);
      const existing = await reqToPromise(os.get(id));
      os.put({
        ...(existing || {}),
        id,
        siteId: binding.siteId,
        name: binding.siteName || existing?.name || binding.siteId,
        bindingId: binding.bindingId,
        deviceId: binding.bindingId,
        physicalDeviceId,
        accessLevel: binding.accessLevel || "manager",
        boundAt: existing?.boundAt || new Date().toISOString(),
      });
    }
  });
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
  "localSessionId",
  "id",
  "siteId",
  "providerSiteId",
  "code",
  "deviceId",
  "bindingId",
  "physicalDeviceId",
  "token",
  "refreshToken",
  "tokenExpiresAt",
  "tokenGeneration",
  "accessLevel",
  "absoluteExpiresAt",
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
  const claim = tokenClaims(token)?.["custom:siteId"];
  return typeof claim === "string" ? claim : "";
}

/**
 * Read the signed session's access level for client-side navigation decisions.
 * The backend remains authoritative and independently enforces admin access.
 * @param {unknown} token
 * @returns {"general"|"manager"|""}
 */
export function accessLevelFromToken(token) {
  const claim = tokenClaims(token)?.accessLevel;
  if (claim === "manager" || claim === "admin") return "manager";
  return claim === "general" ? "general" : "";
}

/**
 * Use the persisted binding when available and the signed token claim as the
 * migration fallback. The backend remains the authorization authority.
 * @param {Record<string, any> | null | undefined} binding
 * @returns {boolean}
 */
export function hasAdminAccess(binding) {
  return ["manager", "admin"].includes(
    binding?.accessLevel || accessLevelFromToken(binding?.token),
  );
}

/** @param {unknown} token @returns {Record<string, unknown> | null} */
function tokenClaims(token) {
  if (typeof token !== "string") return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, any>} [settings] site settings to merge (typically the
 *   GET /v1/site response); binding/session keys are ignored, see above
 * @param {string} [expectedSiteId] when given, write only while the current
 *   record still belongs to this site
 * @param {string} [expectedDeviceId] when given (with `expectedSiteId`), write
 *   only while the record is still the same device binding — a re-bind of the
 *   same site must not inherit settings minted for the previous device
 * @returns {Promise<Record<string, any> | null>} the saved record, or null
 *   when the write was skipped
 */
export async function saveSiteSettings(
  settings = {},
  expectedSiteId,
  expectedDeviceId,
) {
  // Read and write in one transaction: the settings refresh now runs behind
  // the first screen, concurrently with that screen's requests, and a token
  // rotation (updateSiteSession) landing between a separate read and this
  // write would be overwritten with the stale credentials. With
  // `expectedSiteId`, the write is also skipped (null) when the current
  // record is gone or belongs to another site — a settings answer that
  // outlived a sign-out or site switch must not resurrect or rename it.
  return tx("site", "readwrite", (os) =>
    reqToPromise(os.get("current")).then((stored) => {
      if (
        expectedSiteId &&
        (!stored ||
          (stored.siteId && stored.siteId !== expectedSiteId) ||
          (expectedDeviceId && stored.deviceId !== expectedDeviceId))
      ) {
        return null;
      }
      const current = stored || { id: "current", name: "Your site" };
      const incoming = { ...settings };
      // Refresh intent belongs only to the local credential transaction.
      delete incoming.refreshAttempt;
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
      os.put(record);
      if (record.siteId) os.put({ ...record, id: bindingKey(record.siteId) });
      return record;
    }),
  );
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
 * Commit the attempt before sending any refresh request. Reloads and tabs
 * without Web Locks must reuse it until the replacement is committed.
 * @param {string} siteId
 * @param {string} refreshToken
 * @returns {Promise<string | null>}
 */
export async function prepareRefreshAttempt(siteId, refreshToken) {
  return tx("site", "readwrite", (os) =>
    reqToPromise(os.get("current")).then((current) => {
      if (
        !current ||
        current.siteId !== siteId ||
        current.refreshToken !== refreshToken
      )
        return null;
      if (current.refreshAttempt?.refreshToken === refreshToken)
        return current.refreshAttempt.id;
      const refreshAttempt = { id: crypto.randomUUID(), refreshToken };
      os.put({ ...current, refreshAttempt });
      os.put({ ...current, refreshAttempt, id: bindingKey(siteId) });
      return refreshAttempt.id;
    }),
  );
}

/**
 * Persist a refreshed device session onto the existing site record (Option 4
 * device auth). Merge-only: identity fields (id/name/boundAt) stay untouched;
 * only the token fields are replaced. Returns the updated record.
 * @param {{ deviceId: string, token: string, refreshToken: string, expiresIn: number, tokenGeneration: number, accessLevel?: "general"|"manager" }} session
 * @param {string} expectedSiteId
 * @param {string} [expectedRefreshToken] reject late writes after re-enrollment or another rotation
 */
export async function updateSiteSession(
  { deviceId, token, refreshToken, expiresIn, tokenGeneration, accessLevel },
  expectedSiteId,
  expectedRefreshToken,
) {
  // Read and write in one transaction: a site switch must not let a late
  // refresh overwrite the newly selected site's credentials.
  return tx("site", "readwrite", (os) =>
    reqToPromise(os.get("current")).then((current) => {
      if (
        !current ||
        current.siteId !== expectedSiteId ||
        (expectedRefreshToken !== undefined &&
          current.refreshToken !== expectedRefreshToken)
      )
        return null;
      const record = {
        ...current,
        deviceId,
        token,
        refreshToken,
        tokenGeneration,
        accessLevel: accessLevel || current.accessLevel || "general",
        tokenExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      };
      delete record.refreshAttempt;
      os.put(record);
      os.put({ ...record, id: bindingKey(expectedSiteId) });
      return record;
    }),
  );
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

/* ---- finished checks (captured; still uploading or awaiting results) ----
  One record per check under `check:<siteId>:<checkId>` in the `review` store,
  which care submissions share under `care:` keys. Several can wait at once
  when checks are finished offline. Records from the old single-slot layout
  (`site:<siteId>:current`, or the unscoped `current`) move on first read. */
function finishedCheckKey(siteId, checkId) {
  return `check:${siteId}:${checkId}`;
}

/**
 * Every finished check held for a site, oldest first.
 * @param {string} [owningSiteId]
 */
export async function listFinishedChecks(owningSiteId) {
  const siteId = owningSiteId || (await getSite())?.siteId || "";
  if (!siteId) return [];
  const legacyKeys = [draftKey(undefined, siteId), "current"];
  const records = await tx("review", "readwrite", async (os) => {
    const [keys, values] = await Promise.all([
      reqToPromise(os.getAllKeys()),
      reqToPromise(os.getAll()),
    ]);
    const found = [];
    keys.forEach((key, index) => {
      const record = values[index];
      if (!record?.id || record.siteId !== siteId || record.careSubmission)
        return;
      if (key === finishedCheckKey(siteId, record.id)) {
        found.push(record);
      } else if (legacyKeys.includes(String(key))) {
        os.put(record, finishedCheckKey(siteId, record.id));
        os.delete(key);
        found.push(record);
      }
    });
    return found;
  });
  return records.sort((a, b) =>
    (a.submittedAt || "").localeCompare(b.submittedAt || ""),
  );
}
export async function saveFinishedCheck(check) {
  const siteId = check?.siteId || (await getSite())?.siteId || "";
  await tx("review", "readwrite", (os) =>
    os.put(check, finishedCheckKey(siteId, check.id)),
  );
  return check;
}
/**
 * @param {string} owningSiteId
 * @param {string} checkId
 */
export async function deleteFinishedCheck(owningSiteId, checkId) {
  const siteId = owningSiteId || (await getSite())?.siteId || "";
  if (!checkId) return;
  return tx("review", "readwrite", (os) =>
    os.delete(finishedCheckKey(siteId, checkId)),
  );
}

/* ---- last home lists, shown while the API is unreachable ----
  Cleared with every other local record on sign-out (resetLocalAppState). */
/**
 * @param {string} siteId
 * @param {{ checks: any[], tasks: any[] }} lists
 */
export function saveHomeSnapshot(siteId, { checks, tasks }) {
  return tx("review", "readwrite", (os) =>
    os.put(
      { siteId, checks, tasks, savedAt: new Date().toISOString() },
      `home:${siteId}`,
    ),
  );
}
/**
 * @param {string} siteId
 * @returns {Promise<{ siteId: string, checks: any[], tasks: any[], savedAt: string } | null>}
 */
export async function getHomeSnapshot(siteId) {
  const snapshot = await tx("review", "readonly", (os) =>
    reqToPromise(os.get(`home:${siteId}`)),
  );
  return snapshot?.siteId === siteId ? snapshot : null;
}

export async function resetLocalAppState() {
  await tx(["site", "draft", "review"], "readwrite", (_, transaction) => {
    for (const store of ["site", "draft", "review"])
      transaction.objectStore(store).clear();
  });
}

// Every write validates identity and revision in the same transaction as the put.
// Revision zero supports queued records created before versioning was introduced.
export async function saveCareSubmission(
  record,
  mode = "insert",
  binding = null,
) {
  const key = `care:${record.siteId}:${record.workId}`;
  const revision = await tx(
    ["site", "review"],
    "readwrite",
    async (siteStore, transaction) => {
      const site = await reqToPromise(siteStore.get("current"));
      if (
        !site ||
        site.siteId !== record.siteId ||
        site.deviceId !== record.deviceId ||
        (binding && site.localSessionId !== binding.localSessionId)
      )
        throw new Error("Care submission session changed");
      const os = transaction.objectStore("review");
      const current = await reqToPromise(os.get(key));
      if (
        mode === "insert"
          ? Boolean(current)
          : !current ||
            (current.revision || 0) !== (record.revision || 0) ||
            current.deviceId !== record.deviceId ||
            (mode === "edit" &&
              (current.status !== "failed" || !current.editable))
      ) {
        throw Object.assign(new Error("Care submission changed"), {
          code: "care_conflict",
        });
      }
      const next = (current?.revision || 0) + 1;
      await reqToPromise(
        os.put({ ...record, revision: next, careSubmission: true }, key),
      );
      return next;
    },
  );
  record.revision = revision;
}

export async function listCareSubmissions(siteId) {
  const records = await tx("review", "readonly", (os) =>
    reqToPromise(os.getAll()),
  );
  return records.filter(
    (record) => record?.careSubmission && record.siteId === siteId,
  );
}
export function deleteCareSubmission(siteId, workId) {
  return tx("review", "readwrite", (os) =>
    os.delete(`care:${siteId}:${workId}`),
  );
}
