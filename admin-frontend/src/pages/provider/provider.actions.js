// Provider actions, mixed into <admin-provider-page> so tests can mount it alone.
import { actionFeedback } from "../../action-feedback.js";
import { adminApi } from "../../services/admin-api.js";
import { attachCreatedEnrollmentUrl } from "../../enrollment-links.js";
import { beginEnrollmentRequest } from "../../enrollment-request.js";
import { navigate } from "../../router.js";
import { formValue } from "../../form-state.js";
import { removeProviderManagerAccess } from "../../provider-manager-directory.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { upsertRecord } from "../../save-feedback.js";
import { appMessageError } from "../../admin-error-messages.js";

export const providerActions = {
  /**
   * Load active providers visible to central admins.
   * @returns {Promise<void>}
   */
  async loadProviders(visit = this.visit) {
    try {
      const data = await adminApi.listProviders();
      this.catalog.setProviders(data.providers || []);
      // After the user leaves, the error line belongs to the page they went to.
      if (visit !== this.visit) return;
      // An empty message clears <admin-app>'s error line after a good reload.
      this.reportError(new Error(""));
    } catch (err) {
      if (visit !== this.visit) return;
      this.reportError(err);
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
      const visit = this.visit;
      const name = new FormData(form).get("provider-name");
      if (!name) return;
      const result = await adminApi.createProvider(String(name));
      feedback.success();
      this.catalog.addProvider(result.provider);
      if (visit !== this.visit) return;
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
      const visit = this.visit;
      const name = formValue(new FormData(form), "provider-name");
      const result = await adminApi.updateProvider(
        this.state.provider.providerId,
        { name },
      );
      feedback.success();
      this.catalog.updateProvider(result.provider);
      // A late reply must not merge into the provider the user opened next.
      if (visit !== this.visit) return;
      this.state.provider = {
        ...this.state.provider,
        ...result.provider,
      };
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
    const visit = this.visit;
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
        const message = t("admin.enrollment.alreadyActive");
        // The manager's row says it; a user who left the page gets the alert.
        if (
          visit !== this.visit ||
          this.state.provider?.providerId !== providerId
        )
          return feedback.failure(error, { message });
        this.state.providerManagerGrantErrors = {
          ...this.state.providerManagerGrantErrors,
          [membershipId]: message,
        };
        this.render();
        return;
      } else if (
        ["provider_manager_grant_conflict", "manager_grant_conflict"].includes(
          error.message,
        )
      ) {
        feedback.failure(error, { message: t("admin.enrollment.conflict") });
        throw appMessageError(t("admin.enrollment.conflict"));
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
      this.catalog.setPrograms((await adminApi.listPrograms()).programs || []);
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
    const visit = this.visit;
    const [managers, grants] = await Promise.all([
      adminApi.listProviderManagers(providerId),
      adminApi.listProviderManagerGrants(providerId),
    ]);
    if (visit !== this.visit || this.state.provider?.providerId !== providerId)
      return false;
    this.state.providerManagers = managers.managers || [];
    this.state.providerManagerEnrollments = managers.enrollments || [];
    this.state.providerManagerGrants = grants.grants || [];
    if (renderNow) this.render();
    return true;
  },
  /**
   * Read the provider and, for those who manage them, its managers; false when open() or leave() ran again first.
   * @param {string} providerId
   * @returns {Promise<boolean>}
   */
  async loadProvider(providerId) {
    const visit = this.visit;
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
    if (visit !== this.visit) return false;
    if (people) this.state.people = people.people || [];
    this.state.provider = data.provider;
    this.state.providerManagers = managers.managers || [];
    this.state.providerManagerEnrollments = managers.enrollments || [];
    this.state.providerManagerGrants = grants.grants || [];
    this.state.providerManagerGrantErrors = {};
    this.state.siteSaveMessage = "";
    this.state.provider.sites = data.sites || [];
    return true;
  },
  /**
   * Deactivate a provider and return to the provider list.
   * @param {string} providerId
   * @returns {Promise<void>}
   */
  async deactivateProvider(providerId) {
    const feedback = actionFeedback("admin.toast.providerDeactivated");
    try {
      const visit = this.visit;
      await adminApi.deactivateProvider(providerId);
      feedback.success();
      // Cleared only on the same visit, so a late reply can't blank another provider.
      if (visit === this.visit) this.state.provider = null;
      await this.loadProviders(visit);
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
};
