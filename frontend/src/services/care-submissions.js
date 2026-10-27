import { showToast } from "../state/toasts.js";
import { t } from "../i18n/i18n.js";
import { getSite, listCareSubmissions, saveCareSubmission } from "../db.js";
import {
  createCareWork,
  presignCarePhoto,
  putMediaWithProgress,
} from "./api.js";

const active = new Map();
const changed = () => window.dispatchEvent(new Event("caresubmissionschange"));

export async function enqueueCareSubmission(draft) {
  const site = await getSite();
  if (!site?.siteId || site.siteId !== draft.siteId)
    throw new Error("Site changed");
  const record = {
    siteId: site.siteId,
    deviceId: site.deviceId,
    workId: draft.workId,
    kind: draft.kind,
    note: draft.note,
    createdAt: new Date().toISOString(),
    status: "pending",
    payload: null,
    revision: draft.revision,
    files: draft.files.map(({ file, photoId }) => ({
      file,
      photoId,
      uploaded: false,
    })),
  };
  // Only return to the list once the blobs and submission are durably committed.
  await withWorkLock(site.siteId, record.workId, () =>
    saveCareSubmission(record, draft.editing ? "edit" : "insert", site),
  );
  changed();
  void retryCareSubmission(record.workId);
}

function withWorkLock(siteId, workId, run) {
  return globalThis.navigator?.locks
    ? navigator.locks.request(`care:${siteId}:${workId}`, run)
    : run();
}

export async function retryCareSubmission(workId) {
  const site = await getSite().catch(() => null);
  if (!site) return;
  const key = `${site.siteId}:${workId}`;
  if (active.has(key)) return active.get(key);
  const run = async () => {
    const record = (await listCareSubmissions(site.siteId)).find(
      (r) => r.workId === workId,
    );
    if (
      !record ||
      record.status === "saved" ||
      record.deviceId !== site.deviceId
    )
      return;
    await submit(record);
  };
  // Serialize across tabs as well as inside one app instance.
  const promise = withWorkLock(site.siteId, workId, run)
    .catch(() => {
      /* Durable record remains available for recovery. */
    })
    .finally(() => active.delete(key));
  active.set(key, promise);
  return promise;
}

async function submit(record) {
  const options = {
    originSiteId: record.siteId,
    signal: AbortSignal.timeout(120000),
  };
  record.status = "pending";
  await saveCareSubmission(record, "update");
  changed();
  try {
    for (let recovery = 0; ; recovery++) {
      try {
        const site = await getSite();
        if (site?.siteId !== record.siteId || site.deviceId !== record.deviceId)
          throw new Error("Care submission session changed");
        // An uncertain create must replay its exact payload before renewing uploads.
        if (!record.payload) {
          for (const entry of record.files) {
            if (entry.uploaded) continue;
            const reservation = await presignCarePhoto(
              record.workId,
              {
                photoId: entry.photoId,
                contentType: entry.file.type,
                contentLength: entry.file.size,
              },
              options,
            );
            try {
              await putMediaWithProgress(
                reservation.uploadUrl,
                entry.file,
                reservation.uploadHeaders,
                () => {},
                options.signal,
              );
            } catch (error) {
              if (error?.status !== 412) throw error;
            }
            entry.uploaded = true;
            await saveCareSubmission(record, "update");
          }
          record.payload = {
            workId: record.workId,
            kind: record.kind,
            note: record.note,
            photoIds: record.files.map((entry) => entry.photoId),
          };
          await saveCareSubmission(record, "update");
        }
        const result = await createCareWork(record.payload, options);
        record.work = result.work;
        record.status = "saved";
        record.files = [];
        await saveCareSubmission(record, "update");
        if ((await getSite())?.siteId === record.siteId)
          showToast({ title: t("care.success"), message: "", icon: "check" });
        break;
      } catch (error) {
        const expired = record.files.find(
          (entry) => entry.photoId === error?.body?.photoId,
        );
        if (
          recovery < 5 &&
          expired &&
          ["upload_expired", "photo_expired"].includes(error?.body?.error)
        ) {
          expired.photoId = crypto.randomUUID();
          expired.uploaded = false;
          record.payload = null;
          await saveCareSubmission(record, "update");
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    record.editable = [400, 422].includes(error?.status);
    if (record.editable) record.payload = null;
    record.status = "failed";
    await saveCareSubmission(record, "update");
  } finally {
    changed();
  }
}

export async function recoverCareSubmissions() {
  try {
    const site = await getSite();
    if (!site) return;
    for (const record of await listCareSubmissions(site.siteId)) {
      if (record.status === "pending") void retryCareSubmission(record.workId);
    }
    changed();
  } catch {
    /* Storage failure must not prevent app startup. */
  }
}

export function startCareSubmissionRecovery() {
  const resume = () => {
    void recoverCareSubmissions();
  };
  window.addEventListener("online", resume);
  window.addEventListener("pageshow", resume);
  window.addEventListener("sitebound", resume);
  resume();
}
