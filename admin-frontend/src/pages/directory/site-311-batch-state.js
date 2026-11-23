export function create311Batch() {
  return { drafts: new Map(), saving: false, saved: 0 };
}

export function stage311(batch, site, enabled) {
  if (batch.saving) return;
  const previous = batch.drafts.get(site.siteId);
  const original =
    previous?.original ?? site.deliberate311ProductionEnabled !== false;
  if (enabled === original && !previous?.error)
    batch.drafts.delete(site.siteId);
  else
    batch.drafts.set(site.siteId, {
      ...previous,
      siteId: site.siteId,
      name: site.name || site.siteId,
      original,
      enabled,
      expectedUpdatedAt: previous?.expectedUpdatedAt ?? site.updatedAt ?? "",
    });
  batch.saved = 0;
}

/** Each Site is independently version checked and audited by the existing API.
 * Failed/uncertain requests are read back before any subsequent write. */
export async function save311Batch(batch, api, onSite, onProgress = () => {}) {
  if (batch.saving) return;
  batch.saving = true;
  batch.saved = 0;
  onProgress();
  const read = async (draft) => {
    const result = await api.getSite(draft.siteId, false, "settings");
    const site = result.items?.find((item) => item.sk === "#META");
    if (!site || site.status === "inactive") throw new Error("site_not_found");
    onSite(site);
    return site;
  };
  const reconcile = (draft, site) => {
    if ((site.deliberate311ProductionEnabled !== false) === draft.enabled) {
      batch.drafts.delete(draft.siteId);
      batch.saved++;
      return true;
    }
    if ((site.updatedAt || "") !== draft.expectedUpdatedAt) {
      draft.latest = site;
      draft.error = "review";
      return true;
    }
    return false;
  };
  try {
    for (const draft of [...batch.drafts.values()]) {
      if (draft.error === "review") continue;
      try {
        if (draft.error && reconcile(draft, await read(draft))) continue;
        const result = await api.updateSiteDeliberate311(draft.siteId, {
          deliberate311ProductionEnabled: draft.enabled,
          expectedUpdatedAt: draft.expectedUpdatedAt,
        });
        onSite(result.site);
        batch.drafts.delete(draft.siteId);
        batch.saved++;
      } catch {
        draft.error = "retry";
        try {
          reconcile(draft, await read(draft));
        } catch {
          // Keep the draft: a lost response must never be treated as success.
        }
      } finally {
        onProgress();
      }
    }
  } finally {
    batch.saving = false;
    onProgress();
  }
}

export function review311Draft(batch, siteId) {
  const draft = batch.drafts.get(siteId);
  if (batch.saving || !draft?.latest) return;
  draft.original = draft.latest.deliberate311ProductionEnabled !== false;
  draft.expectedUpdatedAt = draft.latest.updatedAt || "";
  delete draft.latest;
  delete draft.error;
  if (draft.original === draft.enabled) batch.drafts.delete(siteId);
}
