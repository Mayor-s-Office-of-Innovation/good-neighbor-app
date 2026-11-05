// Setup code and device actions, mixed into the Site page so they share its state.
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
    const visit = this.visit;
    const result = await adminApi.issueSetupCode(
      this.state.site.siteId,
      email,
      accessLevel,
    );
    // The code is a secret, so it never shows on a page the user went to since.
    if (visit !== this.visit) return;
    this.state.issuedCode = result.setupCode;
    this.render();
  },
  /**
   * Revoke a registered site device.
   * @param {string} deviceId
   * @param {HTMLButtonElement} [button]
   * @returns {Promise<void>}
   */
  async revokeDevice(deviceId, button) {
    const feedback = actionFeedback("admin.toast.accessRemoved");
    this.deviceRevocationController?.abort();
    const controller = new AbortController();
    this.deviceRevocationController = controller;
    const visit = this.visit;
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
        visit !== this.visit ||
        this.state.site?.siteId !== siteId
      )
        return;
      // Disabled only after the dialog, so Cancel can return focus to the button.
      if (button) button.disabled = true;
      await adminApi.revokeDevice(siteId, deviceId);
      feedback.success();
      if ((await this.refreshSiteAccess(siteId, false, visit)) === false)
        return;
      this.state.revocationMessage = t("admin.devices.revokedMessage", {
        name: label,
      });
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    } finally {
      if (button) button.disabled = false;
      if (this.deviceRevocationController === controller)
        this.deviceRevocationController = null;
    }
  },
  async revokeAllSiteDevices(form) {
    const feedback = actionFeedback("admin.toast.accessRemoved");
    try {
      if (!this.state.site) return;
      const siteId = this.state.site.siteId;
      const visit = this.visit;
      const confirmation = formValue(new FormData(form), "confirmation");
      const result = await adminApi.revokeAllSiteDeviceBindings(
        siteId,
        confirmation,
      );
      feedback.success(
        result.status === "complete"
          ? "admin.toast.accessRemoved"
          : "admin.toast.revocationPartial",
        result.status === "complete" ? "success" : "info",
      );
      if ((await this.refreshSiteAccess(siteId, false, visit)) === false)
        return;
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
};
