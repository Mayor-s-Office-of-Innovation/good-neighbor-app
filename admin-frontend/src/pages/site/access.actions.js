// main.js adds these to AdminApp, so they can use this.state and render().
import { actionFeedback } from "../../action-feedback.js";
import { adminApi } from "../../services/admin-api.js";
import { confirmDeviceRevocation } from "./device-revocation-dialog.js";
import { formValue } from "../../form-state.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";

export const siteAccessActions = {
  /**
   * Issue a setup code from the arbitrary email form.
   * @param {HTMLFormElement} form
   * @returns {Promise<void>}
   */
  async issueSetupCode(form) {
    if (!this.state.site) return;
    const data = new FormData(form);
    const email = data.get("setup-email");
    const accessLevel = data.get("setup-access");
    await this.issueSetupCodeForEmail(
      String(email || ""),
      accessLevel === "manager" ? "manager" : "general",
    );
    form.reset();
  },
  /**
   * Issue a setup code to a specific email on the currently open site.
   * @param {string} email
   * @returns {Promise<void>}
   */
  async issueSetupCodeForEmail(email, accessLevel = "general") {
    if (!this.state.site || !email.trim()) return;
    const result = await adminApi.issueSetupCode(
      this.state.site.siteId,
      email,
      accessLevel,
    );
    this.state.issuedCode = result.setupCode;
    this.render();
  },
  /**
   * Revoke a registered site device.
   * @param {string} deviceId
   * @returns {Promise<void>}
   */
  async revokeDevice(deviceId) {
    const feedback = actionFeedback("admin.toast.accessRemoved");
    this.deviceRevocationController?.abort();
    const controller = new AbortController();
    this.deviceRevocationController = controller;
    const generation = this.navigationGeneration || 0;
    try {
      if (!this.state.site) return;
      const device = this.state.devices.find(
        (item) => (item.bindingId || item.deviceId) === deviceId,
      );
      const label = device?.label || t("admin.devices.unnamedDevice");
      const siteId = this.state.site.siteId;
      if (
        !(await confirmDeviceRevocation(label, this.state.site.name, {
          signal: controller.signal,
        }))
      ) {
        return;
      }
      if (
        controller.signal.aborted ||
        !this.isConnected ||
        (this.navigationGeneration || 0) !== generation ||
        this.state.site?.siteId !== siteId
      )
        return;
      await adminApi.revokeDevice(siteId, deviceId);
      feedback.success();
      if ((await this.refreshSiteAccess(siteId, false)) === false) return;
      this.state.revocationMessage = t("admin.devices.revokedMessage", {
        name: label,
      });
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    } finally {
      if (this.deviceRevocationController === controller)
        this.deviceRevocationController = null;
    }
  },
  async revokeAllSiteDevices(form) {
    const feedback = actionFeedback("admin.toast.accessRemoved");
    try {
      if (!this.state.site) return;
      const confirmation = formValue(new FormData(form), "confirmation");
      const result = await adminApi.revokeAllSiteDeviceBindings(
        this.state.site.siteId,
        confirmation,
      );
      feedback.success(
        result.status === "complete"
          ? "admin.toast.accessRemoved"
          : "admin.toast.revocationPartial",
        result.status === "complete" ? "success" : "info",
      );
      const siteId = this.state.site.siteId;
      if ((await this.refreshSiteAccess(siteId, false)) === false) return;
      this.state.revocationMessage =
        result.status === "complete"
          ? `Operation ${result.operationId}: all Site credentials invalidated and ${result.affectedCount} device record${result.affectedCount === 1 ? "" : "s"} reconciled.`
          : `Operation ${result.operationId}: canonical Site credentials were invalidated, but ${result.failedCount} device record${result.failedCount === 1 ? "" : "s"} could not be reconciled. Follow the revocation runbook.`;
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  async revokePhysicalDeviceEverywhere(form) {
    const feedback = actionFeedback("admin.toast.accessRemoved");
    try {
      if (!this.state.site || !this.state.physicalDeviceRevocationPreview)
        return;
      const preview = this.state.physicalDeviceRevocationPreview;
      const confirmation = formValue(new FormData(form), "confirmation");
      const result = await adminApi.revokePhysicalDeviceEverywhere(
        preview.physicalDeviceId,
        confirmation,
      );
      feedback.success();
      const siteId = this.state.site.siteId;
      if ((await this.refreshSiteAccess(siteId, false)) === false) return;
      this.state.revocationMessage = result.alreadyRevoked
        ? "This physical device was already revoked."
        : `Operation ${result.operationId}: physical device revoked across ${result.affectedCount} Site binding${result.affectedCount === 1 ? "" : "s"}.`;
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  async beginEmergencySiteRevocation() {
    const result = await adminApi.listEmergencyRevocationSites();
    this.state.emergencyRevocationSites = result.sites || [];
    this.state.emergencyRevocationPreview = null;
    this.render();
    queueMicrotask(() =>
      this.querySelector("#emergency-site-selection")?.focus(),
    );
  },
  async previewEmergencySiteRevocation(form) {
    const siteIds = new FormData(form)
      .getAll("site-id")
      .map((value) => String(value));
    if (siteIds.length < 2 || siteIds.length > 20) {
      this.state.error =
        "Select between two and 20 Sites for an emergency revocation.";
      this.render();
      return;
    }
    this.state.emergencyRevocationPreview =
      await adminApi.previewEmergencySiteRevocation(siteIds);
    this.render();
    queueMicrotask(() =>
      this.querySelector("#emergency-revocation-confirmation")?.focus(),
    );
  },
  async startEmergencySiteRevocation(form) {
    const feedback = actionFeedback("admin.toast.revocationStarted");
    try {
      const preview = this.state.emergencyRevocationPreview;
      if (!preview) return;
      const confirmation = formValue(new FormData(form), "confirmation");
      const result = await adminApi.startEmergencySiteRevocation(
        preview.sites.map((site) => site.siteId),
        confirmation,
      );
      feedback.success(
        result.enqueueFailedCount
          ? "admin.toast.revocationPartial"
          : "admin.toast.revocationStarted",
        "info",
      );
      this.state.emergencyRevocationSites = [];
      this.state.emergencyRevocationPreview = null;
      this.state.revocationMessage = `Operation ${result.operationId}: credentials invalidated across ${result.affectedSiteCount} Sites; ${result.queuedSiteCount} Site reconciliation job${result.queuedSiteCount === 1 ? "" : "s"} queued${result.enqueueFailedCount ? ` and ${result.enqueueFailedCount} require runbook follow-up` : ""}.`;
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  async suspendDeviceBinding(form) {
    const feedback = actionFeedback("admin.toast.deviceSuspended");
    try {
      if (!this.state.site || !this.state.suspensionTarget) return;
      const reason = formValue(new FormData(form), "reason");
      const bindingId =
        this.state.suspensionTarget.bindingId ||
        this.state.suspensionTarget.deviceId;
      const result = await adminApi.suspendDeviceBinding(
        this.state.site.siteId,
        bindingId,
        reason,
      );
      feedback.success();
      const siteId = this.state.site.siteId;
      if ((await this.refreshSiteAccess(siteId, false)) === false) return;
      this.state.revocationMessage = result.alreadySuspended
        ? "This binding was already suspended."
        : `${result.binding.label || "Device binding"} suspended. Existing credentials are invalid; re-enrollment requires a new single-Site grant.`;
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
};
