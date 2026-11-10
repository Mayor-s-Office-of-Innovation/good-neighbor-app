// Site compliance actions, mixed into the Site page so they share its state.
import { actionFeedback, notifyAdmin } from "../../action-feedback.js";
import { adminApi } from "../../services/admin-api.js";
import { controlValue, selectedComplianceReasons } from "../../form-state.js";
import { letterEmailProgress } from "../../admin-save-state.js";
import { siteLettersView } from "./compliance.templates.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";

export const siteComplianceActions = {
  async createSiteTerms(form) {
    const feedback = actionFeedback("admin.toast.letterQueued");
    try {
      if (!this.state.site) return false;
      const reasons = selectedComplianceReasons(form);
      const siteId = this.state.site.siteId;
      const visit = this.visit;
      const queued = await adminApi.createSiteTerms(siteId, {
        reasons,
        siteManagerUserId: controlValue(form, "terms-site-manager-id"),
        requiredChecksPerDay: Number(
          controlValue(form, "terms-checks-per-day"),
        ),
        periodEnd: controlValue(form, "terms-expiry"),
      });
      feedback.success("admin.toast.letterQueued", "info");
      // The letter is queued; the page the user went to keeps its own URL and reads.
      if (visit !== this.visit) return true;
      window.history.replaceState(
        {},
        "",
        `/sites/${encodeURIComponent(siteId)}?section=compliance`,
      );
      if (!(await this.reloadSite(siteId, visit, false))) return true;
      this.state.expandedLettersSiteId = siteId;
      this.state.siteSaveMessage = t("admin.letters.pending");
      this.render();
      void this.loadSiteLetters(siteId);
      void this.refreshPendingComplianceLetter(siteId);
      void this.refreshLetterEmails(siteId, queued.jobId);
      return true;
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  async readLetterStatus(siteId) {
    this.letterStatusReads ||= new Map();
    const cached = this.letterStatusReads.get(siteId);
    if (cached && Date.now() - cached.at < 1000) return cached.promise;
    const promise = adminApi.getSite(siteId, false, "status");
    this.letterStatusReads.set(siteId, { at: Date.now(), promise });
    try {
      return await promise;
    } catch (error) {
      this.letterStatusReads.delete(siteId);
      throw error;
    }
  },
  async loadSiteLetters(siteId, more = false) {
    const visit = this.visit;
    // Each openSite() makes a new controller, so a letters read started before a reload is stale.
    const siteRead = this.siteReadController;
    if (
      this.lettersLoading?.siteId === siteId &&
      this.lettersLoading.visit === visit &&
      this.lettersLoading.siteRead === siteRead
    )
      return;
    const request = { siteId, visit, siteRead };
    this.lettersLoading = request;
    const isCurrent = () =>
      this.lettersLoading === request &&
      this.visit === visit &&
      this.siteReadController === siteRead &&
      this.state.site?.siteId === siteId;
    try {
      const result = await adminApi.getSiteLetters(
        siteId,
        more ? this.state.letterHistoryCursor || "" : "",
      );
      if (!isCurrent()) return;
      const latest = result.items.find((item) => item.sk === "#META");
      this.state.site = { ...this.state.site, ...latest };
      this.state.letterEmailHistory = [
        ...(more ? this.state.letterEmailHistory : []),
        ...result.items.filter((item) => item.type === "complianceLetterEmail"),
      ];
      this.state.letterEmailUncertain = [
        ...this.state.letterEmailHistory,
        ...result.items.filter((item) => item.type !== "complianceLetterEmail"),
      ].some((item) => item.deliveryState === "uncertain");
      this.state.letterHistoryCursor = result.nextCursor;
      this.renderLetterStatus();
    } catch (error) {
      if (isCurrent()) actionFeedback("admin.toast.failed").failure(error);
    } finally {
      if (this.lettersLoading === request) this.lettersLoading = null;
    }
  },
  renderLetterStatus() {
    const panel = this.querySelector('[aria-labelledby="letters-title"]');
    if (!panel || this.letterResendPending === this.state.site?.siteId) return;
    const focused = document.activeElement;
    const focusSelector = panel.contains(focused)
      ? focused?.closest("#more-letter-history")
        ? "#more-letter-history"
        : focused?.closest("summary")
          ? "summary"
          : null
      : null;
    const template = document.createElement("template");
    template.innerHTML = siteLettersView(this.state);
    panel.replaceWith(template.content.firstElementChild);
    this.applyCapabilities();
    if (focusSelector) {
      const replacement = this.querySelector(
        '[aria-labelledby="letters-title"]',
      );
      (
        replacement?.querySelector(focusSelector) ||
        replacement?.querySelector("summary")
      )?.focus({ preventScroll: true });
    }
  },
  async refreshPendingComplianceLetter(siteId) {
    const visit = this.visit;
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1000 * (attempt + 1), 5000)),
      );
      if (visit !== this.visit || this.state.site?.siteId !== siteId) return;
      if (document.hidden) continue;
      try {
        const result = await this.readLetterStatus(siteId);
        if (visit !== this.visit) return;
        const latest = result.items?.find((item) => item.sk === "#META");
        if (!latest || latest.letterState === "draft_pending") continue;
        this.state.site = { ...this.state.site, ...latest };
        if (this.state.expandedLettersSiteId === siteId)
          await this.loadSiteLetters(siteId);
        return;
      } catch {
        /* Retry reads, never repeat the write. */
      }
    }
  },
  async refreshLetterEmails(siteId, jobId) {
    this.activeLetterJobs ||= new Set();
    this.notifiedLetterJobs ||= new Set();
    if (this.activeLetterJobs.has(jobId) || this.notifiedLetterJobs.has(jobId))
      return;
    this.activeLetterJobs.add(jobId);
    let elapsed = 0;
    const deadline = Date.now() + 60000;
    try {
      while (elapsed < 60000 && Date.now() < deadline) {
        const delay = Math.min(
          this.state.site?.siteId === siteId
            ? Math.min(1000 + elapsed / 2, 5000)
            : 5000,
          60000 - elapsed,
          Math.max(0, deadline - Date.now()),
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        elapsed += delay;
        if (document.hidden) continue;
        try {
          const result = await this.readLetterStatus(siteId);
          const progress = letterEmailProgress(result.items || [], jobId);
          const changed =
            progress.history.length !==
              (this.state.letterEmailHistory?.length || 0) ||
            progress.uncertain !== Boolean(this.state.letterEmailUncertain);
          const isCurrentSite = this.state.site?.siteId === siteId;
          if (isCurrentSite) {
            // Status reads omit document links; retain the rendered history.
            this.state.letterEmailUncertain = progress.uncertain;
            if (progress.sent) {
              this.state.siteSaveMessage = t(
                progress.sent.provider === "local-preview"
                  ? "admin.letters.previewSent"
                  : "admin.letters.sent",
              );
            }
          }
          if (progress.sent || progress.currentUncertain) {
            this.notifiedLetterJobs ||= new Set();
            if (!this.notifiedLetterJobs.has(jobId)) {
              this.notifiedLetterJobs.add(jobId);
              notifyAdmin(
                progress.sent
                  ? progress.sent.provider === "local-preview"
                    ? "admin.letters.previewSent"
                    : "admin.letters.sent"
                  : "admin.toast.deliveryUncertain",
                progress.sent ? "success" : "info",
              );
            }
          }
          if (
            isCurrentSite &&
            (changed || progress.sent) &&
            this.state.expandedLettersSiteId === siteId
          )
            await this.loadSiteLetters(siteId);
          if (progress.sent || progress.currentUncertain) return;
        } catch {
          /* Retry reads without repeating the send. */
        }
      }
      this.notifiedLetterJobs.add(jobId);
      notifyAdmin("admin.toast.letterStillPending", "info");
    } finally {
      this.activeLetterJobs.delete(jobId);
    }
  },
  async endSiteTerms() {
    const feedback = actionFeedback("admin.toast.requirementEnded");
    try {
      if (!this.state.site) return;
      const siteId = this.state.site.siteId;
      const visit = this.visit;
      await adminApi.endSiteTerms(siteId);
      feedback.success();
      if (!(await this.reloadSite(siteId, visit, false))) return;
      this.state.expandedTermsSiteId = siteId;
      this.state.siteSaveMessage = "";
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
};
