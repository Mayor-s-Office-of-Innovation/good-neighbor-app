// main.js adds these to AdminApp, so they can use this.state and render().
import { actionFeedback, notifyAdmin } from "../../action-feedback.js";
import { adminApi } from "../../services/admin-api.js";
import { currentRoute } from "../../router.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";

export const siteImportActions = {
  async openSiteImport() {
    let path = location.pathname + location.search;
    if (this.state.importBusy) {
      this.render();
      return;
    }
    const importId = new URLSearchParams(window.location.search).get(
      "importId",
    );
    if (!importId) {
      this.state.importNotice = null;
      this.state.importPreview = null;
      this.state.importResult = null;
      this.state.importApplyKey = "";
    }
    if (importId && this.state.importPreview?.importId !== importId) {
      this.state.importNotice = null;
      const result = await adminApi.getSiteImport(importId);
      if (location.pathname + location.search !== path) return;
      if (result.import.status === "complete") {
        this.state.importPreview = {
          importId,
          counts: result.import.counts,
          rows: result.rows,
        };
        this.state.importResult = { ...result.import, rows: result.rows };
        this.state.importApplyKey = "";
      } else {
        this.state.importPreview = {
          importId,
          previewVersion: result.import.previewVersion,
          previewExpiresAt: result.import.previewExpiresAt,
          counts: result.import.counts,
          rows: result.rows,
        };
        this.state.importResult = null;
        this.state.importApplyKey =
          sessionStorage.getItem(`site-import-key:${importId}`) ||
          result.import.idempotencyKey ||
          crypto.randomUUID();
        sessionStorage.setItem(
          `site-import-key:${importId}`,
          this.state.importApplyKey,
        );
      }
    }
    const history = await adminApi
      .listSiteImports()
      .catch(() => ({ imports: [] }));
    if (location.pathname + location.search !== path) return;
    this.state.importHistory = history.imports || [];
    this.state.provider = null;
    this.state.program = null;
    this.state.site = null;
    this.state.siteManager = null;
    this.render();
    queueMicrotask(() => this.querySelector("h1")?.focus());
  },
  async previewSiteImport(form) {
    const input = /** @type {HTMLInputElement | null} */ (
      form.querySelector('input[type="file"]')
    );
    const file = input?.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) throw new Error("invalid_file_size");
    this.state.importBusy = true;
    this.state.error = "";
    this.state.importNotice = null;
    this.render();
    try {
      this.state.importPreview = await adminApi.previewSiteImport(
        file.name,
        await file.text(),
      );
      this.state.importResult = null;
      this.state.importApplyKey = crypto.randomUUID();
      sessionStorage.setItem(
        `site-import-key:${this.state.importPreview.importId}`,
        this.state.importApplyKey,
      );
      window.history.pushState(
        {},
        "",
        `/sites/import?importId=${encodeURIComponent(this.state.importPreview.importId)}`,
      );
    } finally {
      this.state.importBusy = false;
      this.render();
    }
  },
  async applySiteImport() {
    const feedback = actionFeedback("admin.toast.importComplete");
    try {
      const preview = this.state.importPreview;
      if (!preview || this.state.importResult?.status === "complete") return;
      this.state.importBusy = true;
      this.render();
      try {
        let result;
        do {
          result = await adminApi.applySiteImport(
            preview.importId,
            preview.previewVersion,
            this.state.importApplyKey,
          );
          if (Number(result.outcomes?.applied || 0) > 0) feedback.changed();
          this.state.importResult = result;
          if (result.rows) this.state.importPreview.rows = result.rows;
          const progress = this.querySelector(".import-progress span");
          if (progress)
            progress.textContent = t("admin.import.outcomeCounts", {
              applied: Number(result.outcomes?.applied || 0),
              failed: Number(result.outcomes?.failed || 0),
            });
        } while (result.status === "applying");
        if (result.status === "complete") {
          const failed =
            Number(result.outcomes?.failed || 0) +
            Number(result.outcomes?.skipped_conflict || 0);
          const applied = Number(result.outcomes?.applied || 0);
          if (
            result.resultStatus === "failed" ||
            (failed > 0 && applied === 0)
          ) {
            feedback.success(
              result.outcomes?.applied
                ? "admin.toast.importPartial"
                : "admin.toast.importFailed",
              applied > 0 ? "info" : "error",
            );
          } else if (result.resultStatus === "partial" || failed > 0) {
            feedback.success(
              result.outcomes?.applied
                ? "admin.toast.importPartial"
                : "admin.toast.importFailed",
              applied > 0 ? "info" : "error",
            );
          } else {
            feedback.success("admin.toast.importComplete", "success", {
              count: applied,
            });
            this.state.importNotice = null;
          }
          this.state.importNotice =
            failed > 0 ||
            result.resultStatus === "failed" ||
            result.resultStatus === "partial"
              ? {
                  title: t(
                    applied > 0
                      ? "admin.toast.importPartial"
                      : "admin.toast.importFailed",
                  ),
                  message: t("admin.import.outcomeCounts", { applied, failed }),
                }
              : null;
          sessionStorage.removeItem(`site-import-key:${preview.importId}`);
          this.state.importApplyKey = "";
          try {
            const history = await adminApi.listSiteImports();
            this.state.importHistory = history.imports || [];
          } catch {
            notifyAdmin("admin.import.historyRefreshFailed", "info");
          }
          this.directoryLoaded = false;
          this.catalogsLoaded = false;
          this.state.managerDirectoryLoaded = false;
          this.managerDirectoryVersion =
            (this.managerDirectoryVersion || 0) + 1;
          if (currentRoute().name === "site-import")
            window.history.replaceState(
              {},
              "",
              `/sites/import?importId=${encodeURIComponent(preview.importId)}`,
            );
        }
      } finally {
        this.state.importBusy = false;
        if (currentRoute().name === "site-import") this.render();
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  cancelSiteImport() {
    const importId = this.state.importPreview?.importId;
    if (importId) sessionStorage.removeItem(`site-import-key:${importId}`);
    this.state.importPreview = null;
    this.state.importResult = null;
    this.state.importNotice = null;
    this.state.importApplyKey = "";
    this.state.importBusy = false;
    this.state.error = "";
    window.history.replaceState({}, "", "/sites/import");
    this.render();
    queueMicrotask(() =>
      this.querySelector('input[name="site-import-file"]')?.focus(),
    );
  },
  async downloadImportConflicts() {
    const feedback = actionFeedback("admin.toast.failed");
    try {
      const importId = this.state.importPreview?.importId;
      if (!importId) return;
      const blob = await adminApi.downloadSiteImportConflicts(importId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `site-import-${importId}-conflicts.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
};
