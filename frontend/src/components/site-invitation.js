/** @param {{label:string,accessLevel:string,firstName:string,lastName:string,email:string}} invitation */
export function validInvitation(invitation) {
  return Boolean(
    invitation.label &&
      invitation.label.length <= 100 &&
      ["general", "manager"].includes(invitation.accessLevel) &&
      (invitation.accessLevel === "general" ||
        (invitation.firstName &&
          invitation.lastName &&
          invitation.firstName.length <= 100 &&
          invitation.lastName.length <= 100 &&
          invitation.email.length <= 320 &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invitation.email))),
  );
}

/** @param {any} view */
export function readInvitation(view) {
  const value = (id) =>
    String(/** @type {any} */ (view.querySelector(id))?.value || "").trim();
  return {
    label: value("#staff-device-label"),
    accessLevel: view.querySelector("#invitation-role")
      ? value("#invitation-role")
      : "general",
    firstName: value("#invitation-first-name"),
    lastName: value("#invitation-last-name"),
    email: value("#invitation-email"),
  };
}

/** @param {any} view */
export function syncInvitation(view) {
  const invitation = readInvitation(view);
  const manager = invitation.accessLevel === "manager";
  const contact = /** @type {HTMLElement | null} */ (
    view.querySelector("#invitation-manager-contact")
  );
  if (contact) contact.hidden = !manager;
  for (const id of [
    "#invitation-first-name",
    "#invitation-last-name",
    "#invitation-email",
  ]) {
    const input = /** @type {any} */ (view.querySelector(id));
    if (input) {
      input.required = manager;
      input.disabled = !manager;
    }
  }
  const button = /** @type {HTMLButtonElement | null} */ (
    view.querySelector("#staff-grant-form button[type=submit]")
  );
  if (button)
    button.disabled = view._creatingInvitation || !validInvitation(invitation);
}
