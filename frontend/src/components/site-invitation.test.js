import { expect, it } from "vitest";
import {
  readInvitation,
  syncInvitation,
  validInvitation,
} from "./site-invitation.js";

function form() {
  const fields = {
    "#staff-device-label": { value: "Team phone" },
    "#invitation-role": { value: "" },
    "#invitation-first-name": { value: "" },
    "#invitation-last-name": { value: "" },
    "#invitation-email": { value: "" },
    "#invitation-manager-contact": { hidden: true },
    "#staff-grant-form button[type=submit]": { disabled: true },
  };
  return {
    _canInviteManagers: true,
    fields,
    querySelector: (id) => fields[id],
  };
}
it("requires an explicit exclusive role choice before enabling creation", () => {
  const view = form();
  syncInvitation(view);
  expect(view.fields["#staff-grant-form button[type=submit]"].disabled).toBe(
    true,
  );
  view.fields["#invitation-role"].value = "general";
  syncInvitation(view);
  expect(view.fields["#staff-grant-form button[type=submit]"].disabled).toBe(
    false,
  );
});
it("requires manager name and email, and removes those requirements for team invitations", () => {
  const view = form();
  view.fields["#invitation-role"].value = "manager";
  syncInvitation(view);
  expect(view.fields["#invitation-manager-contact"].hidden).toBe(false);
  expect(validInvitation(readInvitation(view))).toBe(false);
  view.fields["#invitation-first-name"].value = "New";
  expect(validInvitation(readInvitation(view))).toBe(false);
  view.fields["#invitation-last-name"].value = "Manager";
  view.fields["#invitation-email"].value = "invalid";
  expect(validInvitation(readInvitation(view))).toBe(false);
  view.fields["#invitation-email"].value = "new@example.org";
  syncInvitation(view);
  expect(view.fields["#staff-grant-form button[type=submit]"].disabled).toBe(
    false,
  );
  view.fields["#invitation-role"].value = "general";
  syncInvitation(view);
  expect(view.fields["#invitation-manager-contact"].hidden).toBe(true);
  expect(view.fields["#invitation-email"].required).toBe(false);
});
it("does not enable creation while a request is in flight", () => {
  const view = { ...form(), _creatingInvitation: true };
  view.fields["#invitation-role"].value = "general";
  syncInvitation(view);
  expect(view.fields["#staff-grant-form button[type=submit]"].disabled).toBe(
    true,
  );
});
