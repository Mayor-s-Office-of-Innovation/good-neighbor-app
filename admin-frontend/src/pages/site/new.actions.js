// New Site flow actions, mixed into <admin-new-site-page> so tests can mount it alone.
import { actionFeedback } from "../../action-feedback.js";
import { addressPartsFromForm, formatAddressParts } from "./site-address.js";
import { adminApi } from "../../services/admin-api.js";
import { controlValue, formValue, syncDirtyForm } from "../../form-state.js";
import { navigate } from "../../router.js";
import { siteManagerRoster } from "../../site-managers.js";
import { siteSaveErrorMessage } from "./save-error-messages.js";

export const newSiteActions = {
  async createSiteFromFlow(form) {
    const feedback = actionFeedback("admin.toast.siteCreated");
    const visit = this.visit;
    try {
      const data = new FormData(form);
      const providerId = formValue(data, "provider-id");
      const programId = formValue(data, "lead-program-id");
      const addressParts = addressPartsFromForm(data);
      const address = formatAddressParts(addressParts);
      const expectedManagerId = formValue(data, "site-manager-user-id");
      // Navigation can replace newSiteUsers while the save is pending.
      const staff = this.state.newSiteUsers.find(
        (user) => user.userId === expectedManagerId,
      );
      const result = await adminApi.createSite(providerId, {
        name: formValue(data, "site-name"),
        address,
        addressParts,
        leadProgramId: programId,
        publicContact: {
          email: formValue(data, "public-contact-email"),
          phone: formValue(data, "public-contact-phone"),
          phoneExtension: formValue(data, "public-contact-extension"),
        },
        ...(expectedManagerId
          ? { primaryContactUserId: expectedManagerId }
          : {}),
        siteType: controlValue(form, "site-type"),
      });
      feedback.changed();
      const siteId = result.site.siteId;
      let savedSite = result.site;
      if (
        !result.site.addressParts ||
        !result.site.publicContact ||
        (result.site.primaryContactUserId || "") !== expectedManagerId
      ) {
        if (expectedManagerId)
          await adminApi.assignSiteUser(siteId, expectedManagerId, true);
        const repaired = await adminApi.updateSite(siteId, {
          name: result.site.name,
          addressParts,
          publicContact: {
            email: formValue(data, "public-contact-email"),
            phone: formValue(data, "public-contact-phone"),
            phoneExtension: formValue(data, "public-contact-extension"),
          },
          ...(expectedManagerId
            ? { primaryContactUserId: expectedManagerId }
            : {}),
          siteType: controlValue(form, "site-type"),
        });
        result.site = repaired.site;
        if (
          !repaired.site?.addressParts ||
          !repaired.site?.publicContact ||
          (repaired.site?.primaryContactUserId || "") !== expectedManagerId
        ) {
          throw new Error("site_creation_incomplete");
        }
        savedSite = repaired.site;
      }
      if (staff) {
        const existing = await adminApi.listManagerMemberships(siteId);
        const memberships = existing.memberships || [];
        if (
          !memberships.some((member) => member.userId === expectedManagerId)
        ) {
          const created = await adminApi.createManagerMembership(
            siteId,
            `${staff.firstName} ${staff.lastName}`.trim(),
            staff.email,
            programId,
            expectedManagerId,
          );
          memberships.push(created.membership);
        }
        savedSite = {
          ...savedSite,
          managerMemberships: siteManagerRoster([], memberships),
        };
      }
      this.catalog.addSite(savedSite);
      this.catalog.invalidate("managers");
      this.dropManagerLoad();
      syncDirtyForm(form, true);
      delete form.dataset.saving;
      feedback.success();
      if (visit !== this.visit) return;
      navigate(`/sites/${encodeURIComponent(siteId)}`);
    } catch (error) {
      feedback.failure(error, {
        inlineAvailable: form.isConnected,
        message: siteSaveErrorMessage(error),
      });
      throw error;
    }
  },
};
