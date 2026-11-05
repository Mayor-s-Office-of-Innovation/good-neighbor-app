// AdminApp.bind() adds these again after each render() replaces the HTML.
import { adminApi } from "../../services/admin-api.js";
import { asForm, dataAttr } from "../../dom.js";
import { canEditSite } from "../../site-permissions.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";

/**
 * @typedef {import("../../admin-types.js").AdminAppElement} AdminAppElement
 */

/** @param {AdminAppElement} app */
export function bindSiteAccess(app) {
  app.querySelector("#setup-code-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    app.issueSetupCode(asForm(e.currentTarget));
  });
  app.querySelectorAll("[data-issue-contact-code]").forEach((button) => {
    button.addEventListener("click", () =>
      app.issueSetupCodeForEmail(dataAttr(button, "data-issue-contact-code")),
    );
  });
  app.querySelectorAll("[data-revoke-device]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await app.revokeDevice(button.dataset.revokeDevice);
      } catch (err) {
        app.state.error = err.message;
        app.render();
      } finally {
        button.disabled = false;
      }
    });
  });
  const revokeAllForm = app.querySelector("#revoke-all-site-devices");
  if (revokeAllForm) {
    const input = revokeAllForm.querySelector("wa-input");
    const button = revokeAllForm.querySelector("button");
    let pending = false;
    const sync = () => {
      button.disabled =
        pending ||
        !canEditSite(app.state) ||
        input.value !== app.state.site?.name;
    };
    sync();
    input.addEventListener("input", sync);
    revokeAllForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      sync();
      if (button.disabled) return;
      pending = true;
      input.disabled = true;
      sync();
      try {
        await app.revokeAllSiteDevices(revokeAllForm);
      } catch (err) {
        app.state.error = err.message;
        app.render();
      } finally {
        pending = false;
        input.disabled = !canEditSite(app.state);
        sync();
      }
    });
  }
  const revokeManagerForm = app.querySelector("#revoke-manager-devices");
  if (revokeManagerForm) {
    const input = revokeManagerForm.querySelector("wa-input");
    const button = revokeManagerForm.querySelector("button");
    const sync = () => {
      button.disabled =
        input.value.trim().toLowerCase() !==
        app.state.siteManager.email.toLowerCase();
    };
    input.addEventListener("input", sync);
    revokeManagerForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (button.disabled) return;
      button.disabled = true;
      input.disabled = true;
      const manager = app.state.siteManager;
      const status = revokeManagerForm.querySelector(
        "[data-revocation-status]",
      );
      try {
        const result = manager.personId
          ? await adminApi.revokePersonDevices(manager.personId, input.value)
          : await adminApi.revokeManagerDevices(
              manager.programId,
              manager.userId,
              input.value,
            );
        status.textContent = t("admin.devices.managerRevoked", {
          count: result.affectedCount,
        });
        app.state.managerDirectoryLoaded = false;
        app.managerDirectoryVersion = (app.managerDirectoryVersion || 0) + 1;
        input.value = "";
      } catch {
        status.textContent = t("admin.devices.managerRevokeFailed");
      } finally {
        input.disabled = false;
        sync();
      }
    });
  }
  app
    .querySelector("#physical-device-revocation")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      app.revokePhysicalDeviceEverywhere(event.currentTarget).catch((err) => {
        app.state.error = err.message;
        app.render();
      });
    });
  app
    .querySelector("#cancel-physical-device-revocation")
    ?.addEventListener("click", () => {
      app.state.physicalDeviceRevocationPreview = null;
      app.render();
    });
  app
    .querySelector("#begin-emergency-site-revocation")
    ?.addEventListener("click", () => {
      app.beginEmergencySiteRevocation().catch((err) => {
        app.state.error = err.message;
        app.render();
      });
    });
  app
    .querySelector("#emergency-site-selection")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      app.previewEmergencySiteRevocation(event.currentTarget).catch((err) => {
        app.state.error = err.message;
        app.render();
      });
    });
  app
    .querySelector("#emergency-site-confirmation")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      app.startEmergencySiteRevocation(event.currentTarget).catch((err) => {
        app.state.error = err.message;
        app.render();
      });
    });
  app
    .querySelectorAll("[data-cancel-emergency-revocation]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        app.state.emergencyRevocationSites = [];
        app.state.emergencyRevocationPreview = null;
        app.render();
      });
    });
}
