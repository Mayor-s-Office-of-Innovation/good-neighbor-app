// main.js adds these to AdminApp, so they can use this.state and render().
import { adminCatalog } from "../../admin-catalog.js";
import { actionFeedback } from "../../action-feedback.js";
import { adminApi } from "../../services/admin-api.js";
import { attachCreatedEnrollmentUrl } from "../../enrollment-links.js";
import { beginEnrollmentRequest } from "../../enrollment-request.js";
import { currentRoute, navigate } from "../../router.js";
import { dataAttr } from "../../dom.js";
import { formValue } from "../../form-state.js";
import { removeProviderManagerAccess } from "../../provider-manager-directory.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { upsertRecord } from "../../save-feedback.js";

export const providerActions = {
  /**
   * Load active providers visible to central admins.
   * @returns {Promise<void>}
   */
  async loadProviders() {
    try {
      const data = await adminApi.listProviders();
      adminCatalog.setProviders(data.providers || []);
      this.state.error = "";
    } catch (err) {
      this.state.error = err.message;
    }
    this.render();
  },
  /**
   * Create a provider from the add-provider form.
   * @param {HTMLFormElement} form
   * @returns {Promise<void>}
   */
  async createProvider(form) {
    const feedback = actionFeedback("admin.toast.providerCreated");
    try {
      const origin = location.pathname + location.search;
      const name = new FormData(form).get("provider-name");
      if (!name) return;
      const result = await adminApi.createProvider(String(name));
      feedback.success();
      adminCatalog.addProvider(result.provider);
      if (location.pathname + location.search !== origin) return;
      const params = new URLSearchParams(window.location.search);
      if (params.get("returnTo") === "site-new") {
        navigate(
          `/sites/new?providerId=${encodeURIComponent(result.provider.providerId)}`,
        );
        return;
      }
      navigate(`/providers/${encodeURIComponent(result.provider.providerId)}`);
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  async updateProvider(form) {
    const feedback = actionFeedback("admin.toast.providerSaved");
    try {
      if (!this.state.provider) return;
      const name = formValue(new FormData(form), "provider-name");
      const result = await adminApi.updateProvider(
        this.state.provider.providerId,
        { name },
      );
      feedback.success();
      this.state.provider = {
        ...this.state.provider,
        ...result.provider,
      };
      adminCatalog.updateProvider(result.provider);
      this.state.siteSaveMessage = "";
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  async saveProviderManager(form) {
    const feedback = actionFeedback("admin.toast.providerManagerSaved");
    try {
      if (!this.state.provider) return;
      const data = new FormData(form);
      const values = {
        ...(form.dataset.personId ? { personId: form.dataset.personId } : {}),
        firstName: formValue(data, "provider-manager-first-name"),
        lastName: formValue(data, "provider-manager-last-name"),
        email: formValue(data, "provider-manager-email"),
        phone: formValue(data, "provider-manager-phone"),
        phoneExtension: formValue(data, "provider-manager-extension"),
      };
      const membershipId = formValue(data, "provider-manager-membership-id");
      const providerId = this.state.provider.providerId;
      const result = membershipId
        ? await adminApi.updateProviderManager(providerId, membershipId, values)
        : await adminApi.createProviderManager(providerId, values);
      feedback.success();
      if (this.state.provider?.providerId !== providerId) return;
      this.state.providerManagers = upsertRecord(
        this.state.providerManagers,
        {
          ...this.state.providerManagers.find(
            (manager) => manager.membershipId === membershipId,
          ),
          ...result.manager,
        },
        "membershipId",
      );
      this.state.siteSaveMessage = "";
      this.render();
      if (membershipId) {
        [...this.querySelectorAll("[data-edit-provider-manager]")]
          .find(
            (button) =>
              dataAttr(button, "data-edit-provider-manager") === membershipId,
          )
          ?.focus();
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  async setProviderManagerActive(membershipId, active) {
    const feedback = actionFeedback("admin.toast.accessUpdated");
    try {
      if (!this.state.provider) return;
      if (active) {
        await adminApi.reinstateProviderManager(
          this.state.provider.providerId,
          membershipId,
        );
      } else {
        await removeProviderManagerAccess(
          adminApi,
          this.state.provider.providerId,
          membershipId,
        );
      }
      feedback.success();
      if (
        (await this.refreshProviderAccess(this.state.provider.providerId)) ===
        false
      )
        return;
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  async issueProviderManagerGrant(membershipId, deliveryMode = "link") {
    const release = beginEnrollmentRequest(
      this,
      "provider",
      this.state.provider?.providerId,
    );
    if (!release) return;
    const feedback = actionFeedback("admin.enrollment.emailed");
    const providerId = this.state.provider?.providerId;
    try {
      if (!this.state.provider) return;
      const created = await adminApi.createProviderManagerGrant(
        this.state.provider.providerId,
        membershipId,
        deliveryMode,
      );
      feedback.success(
        created.grant?.deliveryStatus === "accepted"
          ? deliveryMode === "code"
            ? "admin.enrollment.codeEmailed"
            : "admin.enrollment.emailed"
          : "admin.toast.enrollmentEmailFailed",
        created.grant?.deliveryStatus === "accepted" ? "success" : "error",
      );
      if (
        (await this.refreshProviderAccess(
          this.state.provider.providerId,
          false,
        )) === false
      )
        return;
      this.state.providerManagerGrants = attachCreatedEnrollmentUrl(
        this.state.providerManagerGrants,
        created,
      );
      this.render();
    } catch (error) {
      if (error.message === "provider_manager_grant_already_active") {
        error.message = t("admin.enrollment.alreadyActive");
        feedback.failure(error);
        if (this.state.provider?.providerId === providerId) {
          this.state.providerManagerGrantErrors = {
            ...this.state.providerManagerGrantErrors,
            [membershipId]: error.message,
          };
          this.render();
        }
        return;
      } else if (
        ["provider_manager_grant_conflict", "manager_grant_conflict"].includes(
          error.message,
        )
      ) {
        error.message = t("admin.enrollment.conflict");
      }
      feedback.failure(error);
      throw error;
    } finally {
      release();
    }
  },

  async cancelProviderManagerGrant(grantId) {
    const feedback = actionFeedback("admin.toast.linkCancelled");
    try {
      if (!this.state.provider) return;
      await adminApi.cancelProviderManagerGrant(
        this.state.provider.providerId,
        grantId,
      );
      feedback.success();
      if (
        (await this.refreshProviderAccess(this.state.provider.providerId)) ===
        false
      )
        return;
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  async revokeProviderManagerEnrollment(enrollmentId) {
    const feedback = actionFeedback("admin.toast.accessRemoved");
    try {
      if (!this.state.provider) return;
      await adminApi.revokeProviderManagerEnrollment(
        this.state.provider.providerId,
        enrollmentId,
      );
      feedback.success();
      if (
        (await this.refreshProviderAccess(this.state.provider.providerId)) ===
        false
      )
        return;
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  async addProgramToProvider(form) {
    const feedback = actionFeedback("admin.toast.programAssigned");
    try {
      if (!this.state.provider) return;
      const providerId = this.state.provider.providerId;
      const programId = formValue(new FormData(form), "program-id");
      if (!programId) return;
      await adminApi.assignProgramToProvider(providerId, programId);
      feedback.success();
      adminCatalog.setPrograms((await adminApi.listPrograms()).programs || []);
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  /**
   * Refresh access state after a provider access mutation.
   * @param {string} providerId
   * @param {boolean} [renderNow]
   */
  async refreshProviderAccess(providerId, renderNow = true) {
    const [managers, grants] = await Promise.all([
      adminApi.listProviderManagers(providerId),
      adminApi.listProviderManagerGrants(providerId),
    ]);
    if (
      this.state.provider?.providerId !== providerId ||
      !["provider", "provider-manager"].includes(currentRoute().name)
    )
      return false;
    this.state.providerManagers = managers.managers || [];
    this.state.providerManagerEnrollments = managers.enrollments || [];
    this.state.providerManagerGrants = grants.grants || [];
    if (renderNow) this.render();
    return true;
  },
  async openProvider(providerId, updateUrl = true) {
    if (updateUrl)
      return navigate(`/providers/${encodeURIComponent(providerId)}`);
    const path = location.pathname + location.search;
    const canManage = this.state.capabilities.manageProviderManagers === true;
    const [data, managers, grants, people] = await Promise.all([
      adminApi.getProvider(providerId),
      canManage
        ? adminApi.listProviderManagers(providerId)
        : Promise.resolve({ managers: [] }),
      canManage
        ? adminApi.listProviderManagerGrants(providerId)
        : Promise.resolve({ grants: [] }),
      canManage ? adminApi.listPeople() : null,
    ]);
    if (location.pathname + location.search !== path) return;
    if (people) this.state.people = people.people || [];
    this.state.provider = data.provider;
    this.state.providerManagers = managers.managers || [];
    this.state.providerManagerEnrollments = managers.enrollments || [];
    this.state.providerManagerGrants = grants.grants || [];
    this.state.providerManagerGrantErrors = {};
    this.state.site = null;
    this.state.siteManager = null;
    this.state.siteSaveMessage = "";
    this.state.siteSaveError = "";
    this.state.provider.sites = data.sites || [];
    this.render();
    queueMicrotask(() => this.querySelector("h1")?.focus());
  },
  /**
   * Deactivate a provider and return to the provider list.
   * @param {string} providerId
   * @returns {Promise<void>}
   */
  async deactivateProvider(providerId) {
    const feedback = actionFeedback("admin.toast.providerDeactivated");
    try {
      await adminApi.deactivateProvider(providerId);
      feedback.success();
      this.state.provider = null;
      this.state.site = null;
      await this.loadProviders();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
};
