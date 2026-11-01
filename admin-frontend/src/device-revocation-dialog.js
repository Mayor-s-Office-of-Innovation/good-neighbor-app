import { t } from "../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../frontend/src/lib/html.js";

/** Confirm a site binding removal without using the browser confirmation UI. */
export function confirmDeviceRevocation(label, siteName) {
  const trigger = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "places-modal device-revocation-dialog";
  dialog.setAttribute("aria-labelledby", "device-revocation-title");
  dialog.setAttribute("aria-describedby", "device-revocation-copy");
  dialog.innerHTML = `<form class="places-modal__card" method="dialog">
    <div class="places-modal__copy">
      <h2 class="places-modal__title" id="device-revocation-title">${escapeHtml(t("admin.devices.revokeTitle"))}</h2>
      <p class="places-modal__text" id="device-revocation-copy">${escapeHtml(t("admin.devices.revokeDescription", { name: label, site: siteName }))}</p>
    </div>
    <div class="places-modal__actions">
      <button class="btn-danger" value="confirm">${escapeHtml(t("access.revoke"))}</button>
      <button class="btn-outline" value="cancel" autofocus>${escapeHtml(t("common.cancel"))}</button>
    </div>
  </form>`;
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        const confirmed = dialog.returnValue === "confirm";
        dialog.remove();
        if (trigger instanceof HTMLElement && trigger.isConnected)
          trigger.focus({ preventScroll: true });
        resolve(confirmed);
      },
      { once: true },
    );
    dialog.showModal();
  });
}
