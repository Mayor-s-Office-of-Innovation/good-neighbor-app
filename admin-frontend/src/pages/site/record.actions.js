// Site record actions, mixed into the Site page so they share its state.
import { actionFeedback } from "../../action-feedback.js";
import { addressPartsFromForm, hasSiteCoordinates } from "./site-address.js";
import { adminApi } from "../../services/admin-api.js";
import { adminErrorMessage } from "../../admin-error-messages.js";
import {
  controlValue,
  formValue,
  hasEnteredValues,
  showFormSaveError,
  syncDirtyForm,
} from "../../form-state.js";
import { navigate } from "../../router.js";
import { activeSiteSection } from "./site-section.js";
import { selectedLeadProgram } from "./site-assignment.js";
import { siteManagerRoster } from "../../site-managers.js";
import { siteSaveErrorMessage } from "./save-error-messages.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { withSaveFeedback } from "../../save-feedback.js";

/**
 * The tab the URL's `section` asks for.
 * @param {import("../../admin-session.js").AdminSession} session
 */
export function currentSiteSection(session) {
  return activeSiteSection(
    new URLSearchParams(window.location.search).get("section"),
    session.capabilities,
  );
}

export const siteRecordActions = {
  /**
   * Reread the Access tab's lists; false when the user left during `visit`'s save or this read.
   * @param {string} siteId
   * @param {number} [visit] the page's visit when the caller's save started
   */
  async refreshSiteAccess(siteId, renderNow = true, visit = this.visit) {
    if (visit !== this.visit) return false;
    const [memberships, grants, devices] = await Promise.all([
      adminApi.listManagerMemberships(siteId),
      adminApi.listManagerGrants(siteId),
      adminApi.listDevices(siteId),
    ]);
    if (visit !== this.visit || this.state.site?.siteId !== siteId)
      return false;
    this.state.managerMemberships = siteManagerRoster(
      this.state.assignedUsers,
      memberships.memberships || [],
      this.state.availableSiteUsers,
    );
    this.state.managerGrants = grants.grants || [];
    this.state.devices = devices.devices || [];
    this.siteSectionLoads?.clear();
    if (renderNow) this.render();
    return true;
  },
  /** @param {HTMLFormElement} form */
  async updateSiteDeliberate311(form) {
    if (!this.state.site || this.state.capabilities.createEntities !== true)
      return false;
    const site = this.state.site;
    const select = form.querySelector(
      'wa-select[name="deliberate-311-enabled"]',
    );
    const feedback = actionFeedback("admin.toast.siteSaved");
    return withSaveFeedback(
      form,
      async () => {
        const enabled = controlValue(form, "deliberate-311-enabled") === "true";
        if (select) select.disabled = true;
        try {
          const result = await adminApi.updateSiteDeliberate311(site.siteId, {
            deliberate311ProductionEnabled: enabled,
            expectedUpdatedAt: site.updatedAt || "",
          });
          this.catalog.addSite({ ...site, ...result.site });
          if (this.state.site?.siteId === site.siteId)
            this.state.site = { ...this.state.site, ...result.site };
          syncDirtyForm(form, true);
          feedback.success();
          return true;
        } finally {
          if (select) select.disabled = false;
        }
      },
      {
        savingLabel: t("siteAdmin.edit.saving"),
        onError: (error) => {
          feedback.failure(error);
          showFormSaveError(form, adminErrorMessage(error, t));
        },
      },
    );
  },
  /**
   * @param {HTMLFormElement} form
   * @param {"all" | "details" | "address" | "lead-program" | "site-manager"} [section]
   */
  async updateSite(form, section = "all") {
    if (form.dataset.readOnly === "true") return false;
    const feedback = actionFeedback("admin.toast.siteSaved");
    try {
      if (!this.state.site) return;
      const siteId = this.state.site.siteId;
      const visit = this.visit;
      const data = new FormData(form);
      const name = formValue(data, "site-name");
      const leadProgramId = formValue(data, "lead-program-id");
      const leadProviderId =
        formValue(data, "lead-provider-id") || this.state.site.providerId;
      const addressParts = data.has("street-address")
        ? addressPartsFromForm(data)
        : null;
      const publicContact = {
        email: formValue(data, "public-contact-email"),
        phone: formValue(data, "public-contact-phone"),
        phoneExtension: formValue(data, "public-contact-extension"),
      };
      /** @type {Record<string, unknown>} */
      const values = {
        name:
          section === "all" || section === "details"
            ? name
            : this.state.site.name,
      };
      if (section === "all" || section === "details")
        values.publicContact = publicContact;
      if (section === "all" || section === "details")
        values.siteType = controlValue(form, "site-type");
      if (
        (section === "all" || section === "address") &&
        addressParts &&
        hasEnteredValues(addressParts)
      )
        values.addressParts = addressParts;
      this.state.siteSaving = true;
      this.state.siteSaveMessage = "";
      this.state.siteSaveError = "";
      try {
        if (
          (section === "all" || section === "lead-program") &&
          (leadProgramId !== String(this.state.site.leadProgramId || "") ||
            leadProviderId !== this.state.site.providerId)
        ) {
          const leadProgram = selectedLeadProgram(
            this.state.programs,
            leadProgramId,
          );
          if (leadProgramId && !leadProgram) {
            throw new Error("lead_program_required");
          }
          const reassignment = await adminApi.reassignSite(
            siteId,
            leadProviderId,
            leadProgramId,
            { expectedUpdatedAt: form.dataset.reassignmentVersion },
          );
          feedback.changed();
          // A Site page the user has left shows another Site, or none.
          if (visit === this.visit) {
            this.state.site = { ...this.state.site, ...reassignment.site };
            this.catalog.addSite(this.state.site);
          } else this.catalog.updateSite(siteId, reassignment.site);
        }
        if (section === "lead-program") {
          feedback.success("admin.toast.leadProgramSaved");
          this.state.siteSaveMessage = "";
          return true;
        }
        const result = await adminApi.updateSite(siteId, values);
        feedback.changed();
        if (visit === this.visit) {
          this.state.site = { ...this.state.site, ...result.site };
          this.catalog.updateSite(siteId, this.state.site);
        } else this.catalog.updateSite(siteId, result.site);
        if (values.addressParts && !hasSiteCoordinates(result.site?.location)) {
          this.state.siteSaveError =
            "The address was saved, but geocoding did not return coordinates. Try saving it again.";
          feedback.success("admin.toast.addressCoordinatesMissing", "info");
          return false;
        }
        feedback.success(
          section === "address"
            ? "admin.toast.addressSaved"
            : "admin.toast.siteSaved",
        );
        this.state.siteSaveMessage = "";
        return true;
      } catch (error) {
        feedback.failure(error);
        this.state.siteSaveError = siteSaveErrorMessage(error);
        return false;
      } finally {
        this.state.siteSaving = false;
        if (this.state.siteSaveError) {
          showFormSaveError(form, this.state.siteSaveError);
        } else if (visit === this.visit) {
          this.render();
        }
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  async updatePerimeter(form) {
    const feedback = actionFeedback("admin.toast.perimeterSaved");
    try {
      if (!this.state.site) return false;
      const perimeter = formValue(new FormData(form), "perimeter");
      if (!perimeter) {
        showFormSaveError(form, "Enter a perimeter description before saving.");
        return false;
      }
      this.state.perimeterSaving = true;
      this.state.perimeterMessage = "";
      this.state.perimeterError = "";
      this.state.revocationMessage = "";
      this.render();
      const visit = this.visit;
      try {
        const result = await adminApi.updateSitePerimeter(
          this.state.site.siteId,
          perimeter,
          String(this.state.site.updatedAt || ""),
        );
        // The perimeter is saved; a Site page the user has left shows another Site, or none.
        if (visit !== this.visit) {
          feedback.success();
          return true;
        }
        this.state.site = { ...this.state.site, ...result };
        feedback.success();
        this.state.perimeterMessage = "";
        return true;
      } catch (error) {
        feedback.failure(error);
        this.state.perimeterError =
          error instanceof Error &&
          error.message === "perimeter_update_conflict"
            ? "This Site changed after you opened it. Reload the latest version before saving."
            : "The perimeter could not be saved. Check the text and try again.";
        return false;
      } finally {
        this.state.perimeterSaving = false;
        if (this.state.perimeterError) {
          showFormSaveError(form, this.state.perimeterError);
        } else if (visit === this.visit) {
          this.render();
        }
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  /**
   * Open a site with its contacts and devices; false when the user left first.
   * @param {string} siteId
   * @returns {Promise<boolean | void>}
   */
  async openSite(siteId, updateUrl = true, refresh = true, renderNow = true) {
    if (updateUrl) return navigate(`/sites/${encodeURIComponent(siteId)}`);
    const visit = this.visit;
    const section = currentSiteSection(this.session);
    const sameSite = this.state.site?.siteId === siteId;
    this.siteSectionLoads ||= new Map();
    if (!sameSite || refresh) this.siteSectionLoads.clear();
    if (
      !refresh &&
      sameSite &&
      !this.catalog.programManagersStale &&
      Date.now() - (this.siteSectionLoads.get(section) || 0) < 30000
    ) {
      if (renderNow) {
        this.render();
        this.revealSite(section, true);
      }
      return true;
    }
    if (!sameSite) {
      this.state.expandedLettersSiteId = null;
      this.state.expandedTermsSiteId = null;
      this.state.letterHistoryCursor = "";
    }
    this.siteReadController?.abort();
    const controller = (this.siteReadController = new AbortController());
    const needsRoster = ["details", "access", "compliance"].includes(section);
    const [
      site,
      memberships,
      grants,
      devices,
      terms,
      programManagers,
      peopleResult,
    ] = await Promise.all([
      adminApi.getSite(siteId, false, section, controller.signal),
      section === "access" ? adminApi.listManagerMemberships(siteId) : null,
      section === "access" ? adminApi.listManagerGrants(siteId) : null,
      section === "access" ? adminApi.listDevices(siteId) : null,
      section === "compliance" ? adminApi.listSiteTerms(siteId) : null,
      this.catalog.programManagersStale
        ? adminApi.listCityProgramManagers()
        : null,
      needsRoster ? adminApi.listPeople() : null,
    ]);
    const latest = site.items?.find((item) => item.sk === "#META");
    const program =
      needsRoster && latest?.leadProgramId
        ? await adminApi.getProgram(latest.leadProgramId)
        : null;
    // A newer openSite() replaced the controller; its reply is the one to show.
    if (controller !== this.siteReadController || visit !== this.visit)
      return false;
    if (programManagers) {
      this.catalog.programManagersReloaded(
        programManagers.programManagers || [],
      );
    }
    this.state.siteCanEdit = site.permissions?.canEdit === true;
    if (section === "compliance" || !sameSite) {
      this.state.letterEmailUncertain = (site.items || []).some(
        (item) => item.deliveryState === "uncertain",
      );
      this.state.letterEmailHistory = (site.items || []).filter(
        (item) => item.type === "complianceLetterEmail",
      );
    }
    this.state.site = latest
      ? { ...(sameSite ? this.state.site : {}), ...latest }
      : null;
    if (this.state.site) {
      const current = this.state.site;
      this.catalog.updateSite(siteId, (summary) => ({
        ...summary,
        ...current,
        primaryContactUserId: current.primaryContactUserId,
        primaryContact: current.primaryContact,
      }));
    }
    if (needsRoster) {
      this.state.assignedUsers = (site.items || []).filter((item) =>
        String(item.sk || "").startsWith("ASSIGNED_USER#"),
      );
    }
    if (section !== "settings" || !sameSite) {
      this.state.assignedComplianceManagers = (site.items || [])
        .filter((item) =>
          String(item.sk || "").startsWith("COMPLIANCE_MANAGER#"),
        )
        .map((assignment) => ({
          ...assignment,
          ...this.state.programManagers.find(
            (manager) => manager.userId === assignment.managerId,
          ),
        }));
    }
    const people =
      peopleResult?.people || (sameSite ? this.state.people || [] : []);
    this.state.people = people;
    if (needsRoster)
      this.state.availableSiteUsers = [
        ...people.map((person) => ({ ...person, userId: person.personId })),
        ...(program?.users || []).filter(
          (user) => user.status !== "inactive" && !user.personId,
        ),
      ];
    if (terms) this.state.siteTerms = terms.terms || [];
    else if (!sameSite) this.state.siteTerms = [];
    if (needsRoster) {
      this.state.managerMemberships = siteManagerRoster(
        this.state.assignedUsers,
        memberships?.memberships ||
          (site.items || []).filter(
            (item) => item.type === "managerMembership",
          ),
        this.state.availableSiteUsers,
      );
      this.state.managerMemberships = this.state.managerMemberships.map(
        (member) => {
          const person = people.find((p) => p.personId === member.personId);
          return person
            ? {
                ...member,
                firstName: person.firstName,
                lastName: person.lastName,
                name: person.name,
                email: person.email,
              }
            : member;
        },
      );
      this.state.assignedUsers = this.state.managerMemberships
        .filter(
          (membership) =>
            (membership.personId || membership.userId) &&
            this.state.availableSiteUsers.some(
              (user) =>
                user.userId === (membership.personId || membership.userId),
            ),
        )
        .map((membership) => ({
          ...membership,
          ...(this.state.availableSiteUsers.find(
            (user) =>
              user.userId === (membership.personId || membership.userId),
          ) || {}),
        }));
      this.catalog.updateSite(siteId, {
        managerMemberships: this.state.managerMemberships,
      });
    }
    if (grants) this.state.managerGrants = grants.grants || [];
    else if (!sameSite) this.state.managerGrants = [];
    if (devices) this.state.devices = devices.devices || [];
    else if (!sameSite) this.state.devices = [];
    this.state.issuedCode = null;
    this.state.siteSaveMessage = "";
    this.state.siteSaveError = "";
    this.state.perimeterSaving = false;
    this.state.perimeterMessage = "";
    this.state.perimeterError = "";
    this.siteSectionLoads.set(section, Date.now());
    if (renderNow) {
      this.render();
      this.revealSite(section, !refresh);
    }
    return true;
  },
  /**
   * Reread the Site after a save. Skipped once the user has left, since
   * openSite() would cancel the read for the page they went to.
   * @param {string} siteId
   * @param {number} visit the page's visit when the save started
   */
  async reloadSite(siteId, visit, renderNow = true) {
    if (visit !== this.visit) return false;
    try {
      return await this.openSite(siteId, false, true, renderNow);
    } catch (error) {
      // Leaving aborts the reread; the save itself worked, so that isn't a failure.
      if (error?.name === "AbortError" || visit !== this.visit) return false;
      throw error;
    }
  },
  /**
   * Load the open letters list and move focus to the Site's heading.
   * @param {string} section
   * @param {boolean} scrollToTop
   */
  revealSite(section, scrollToTop) {
    const siteId = this.state.site?.siteId;
    if (section === "compliance" && this.state.expandedLettersSiteId === siteId)
      void this.loadSiteLetters(siteId);
    queueMicrotask(() => {
      const heading = this.querySelector("h1");
      heading?.focus({ preventScroll: true });
      // Navigation starts at the page top, independently of the heading's position.
      if (scrollToTop)
        heading?.ownerDocument.defaultView?.scrollTo({
          top: 0,
          left: 0,
          behavior: "instant",
        });
    });
  },
  /**
   * Deactivate a site and refresh the current provider.
   * @param {string} siteId
   * @returns {Promise<void>}
   */
  async deactivateSite(siteId) {
    const feedback = actionFeedback("admin.toast.siteDeactivated");
    try {
      await adminApi.deactivateSite(siteId);
      feedback.success();
      this.catalog.removeSite(siteId);
      this.catalog.invalidate("managers");
      this.state.site = null;
      this.querySelector("[data-dirty-form]")?.setAttribute(
        "data-is-dirty",
        "false",
      );
      // An empty path skips <admin-app>'s unsaved-changes check, so leaving a deactivated Site doesn't prompt.
      this.reportPath("");
      navigate("/sites");
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
};
