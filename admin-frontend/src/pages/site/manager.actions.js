// main.js adds these to AdminApp, so they can use this.state and render().
import {
  DIRECTORY_REQUEST_CONCURRENCY,
  createDirectoryLoader,
  loadManagerDirectory,
} from "../../manager-directory.js";
import { actionFeedback, notifyAdmin } from "../../action-feedback.js";
import { adminApi } from "../../services/admin-api.js";
import { adminErrorMessage } from "../../admin-error-messages.js";
import {
  attachCreatedEnrollmentUrl,
  copyEnrollmentUrl,
} from "../../enrollment-links.js";
import { beginEnrollmentRequest } from "../../enrollment-request.js";
import { createAndAssignManager } from "./pending-manager.js";
import { currentRoute, navigate } from "../../router.js";
import { dataAttr } from "../../dom.js";
import { formValue, showFormSaveError } from "../../form-state.js";
import { managerSaveErrorMessage } from "./save-error-messages.js";
import { peopleDirectory } from "./people-directory.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { upsertRecord, withSaveFeedback } from "../../save-feedback.js";

export const siteManagerActions = {
  async loadSearchManagers() {
    if (this.state.managerDirectoryLoaded || this.managerSearchPending) return;
    this.managerSearchPending = true;
    this.state.managerSearchFailed = false;
    try {
      await this.loadSiteManagers();
    } catch {
      this.state.managerSearchFailed = true;
    } finally {
      this.managerSearchPending = false;
    }
    const input = this.querySelector("#directory-search-input");
    if (
      !input ||
      (!new URLSearchParams(location.search).get("q")?.trim() &&
        currentRoute().name !== "managers")
    )
      return;
    this.renderDirectoryResults();
  },
  async loadSiteManagers(force = false) {
    this.managerDirectoryLoader ||= createDirectoryLoader(() =>
      this.fetchSiteManagers(),
    );
    if (
      this.state.managerDirectoryLoaded &&
      !force &&
      !this.managerDirectoryLoader.pending
    )
      return;
    return this.managerDirectoryLoader.load(
      force ||
        (this.managerDirectoryLoader.pending &&
          this.managerFetchVersion !== (this.managerDirectoryVersion || 0)),
    );
  },
  async fetchSiteManagers() {
    const version = (this.managerFetchVersion =
      this.managerDirectoryVersion || 0);
    const activePrograms = this.state.programs.filter(
      (program) => program.status !== "inactive",
    );
    const activeSites = this.state.sites.filter(
      (site) => site.status !== "inactive",
    );
    const { programDetails, siteMemberships } = await loadManagerDirectory(
      activePrograms,
      activeSites,
      adminApi,
      DIRECTORY_REQUEST_CONCURRENCY,
    );
    if (version !== (this.managerDirectoryVersion || 0)) return;
    const memberships = siteMemberships.flatMap(({ site, memberships }) =>
      (memberships || []).map((membership) => ({
        ...membership,
        siteId: site.siteId,
        siteName: site.name,
        leadProgramId: site.leadProgramId,
      })),
    );
    const legacyManagers = programDetails
      .flatMap((detail) =>
        (detail.users || []).flatMap((user) => {
          if (user.status === "inactive") return [];
          const assignedSites = memberships.filter(
            (membership) =>
              membership.userId === user.userId ||
              (!membership.userId &&
                membership.leadProgramId === detail.program.programId &&
                String(membership.email || "").toLowerCase() ===
                  String(user.email || "").toLowerCase()),
          );
          if (user.siteManager !== true && !assignedSites.length) return [];
          return [
            {
              ...user,
              programId: detail.program.programId,
              programName: detail.program.name,
              providerId: detail.program.providerId,
              assignedSites,
            },
          ];
        }),
      )
      .sort((a, b) =>
        `${a.firstName} ${a.lastName}`.localeCompare(
          `${b.firstName} ${b.lastName}`,
        ),
      );
    const { people = [] } = await adminApi.listPeople();
    if (version !== (this.managerDirectoryVersion || 0)) return;
    this.state.people = people;
    this.state.siteManagers = peopleDirectory(
      people,
      memberships,
      this.state.programs,
      this.state.providers,
      legacyManagers,
    );
    this.state.managerDirectoryLoaded = true;
    this.state.managerSearchFailed = false;
  },
  async openSiteManager(userId) {
    const path = location.pathname + location.search;
    await this.loadSiteManagers();
    if (location.pathname + location.search !== path) return;
    this.state.siteSaveMessage = "";
    this.state.siteSaveError = "";
    this.state.siteManager =
      this.state.siteManagers.find(
        (manager) =>
          manager.userId === userId || manager.legacyUserIds?.includes(userId),
      ) || null;
    this.state.provider = null;
    this.state.program = null;
    this.state.site = null;
    if (!this.state.siteManager) this.state.error = "Site manager not found.";
    else if (this.state.siteManager.userId !== userId)
      window.history.replaceState(
        {},
        "",
        `/managers/${encodeURIComponent(this.state.siteManager.userId)}${location.search}`,
      );
    this.render();
    queueMicrotask(() => this.querySelector("h1")?.focus());
  },
  /** @param {HTMLFormElement} form */
  async createSiteManagerFromAccess(form) {
    const feedback = actionFeedback("admin.toast.managerAssigned");
    try {
      if (form.dataset.saving) return;
      form.dataset.saving = "true";
      const save = form.querySelector('button[type="submit"]');
      const cancel = form.querySelector("[data-cancel-new-site-manager]");
      save.disabled = true;
      cancel.disabled = true;
      const siteId = this.state.site.siteId;
      const programId = this.state.site.leadProgramId;
      const creationGeneration = this.navigationGeneration;
      let assignedMembership;
      let emailRequested = false;
      try {
        const data = new FormData(form);
        emailRequested = Boolean(data.get("email-enrollment-link"));
        const values = {
          firstName: formValue(data, "new-manager-first-name"),
          lastName: formValue(data, "new-manager-last-name"),
          phone: formValue(data, "new-manager-phone"),
          phoneExtension: formValue(data, "new-manager-extension"),
          email: formValue(data, "new-manager-email"),
          siteManager: true,
        };
        this.pendingManagerCreations ||= new Map();
        const pendingUser = this.pendingManagerCreations.get(
          JSON.stringify([siteId, programId, values]),
        );
        if (pendingUser) {
          feedback.changed();
          form.dataset.createdUser = JSON.stringify(pendingUser);
        }
        await createAndAssignManager(
          this.pendingManagerCreations,
          { siteId, programId, values },
          {
            createProgramUser: async (...args) => {
              const created = await adminApi.createPerson({
                ...args[1],
                siteId,
              });
              const result = {
                user: { ...created.person, userId: created.person.personId },
              };
              feedback.changed();
              form.dataset.createdUser = JSON.stringify(result.user);
              return result;
            },
            createManagerMembership: async (
              siteId,
              name,
              email,
              programId,
              userId,
            ) => {
              const assigned = await adminApi.assignPersonToSite(siteId, {
                personId: userId,
                name,
                email,
              });
              assignedMembership = assigned?.membership;
              return assigned;
            },
          },
        );
        feedback.success();
        this.state.managerDirectoryLoaded = false;
        this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
      } catch (error) {
        feedback.failure(error);
        showFormSaveError(
          form,
          form.dataset.createdUser
            ? t("admin.siteManagers.assignmentError")
            : adminErrorMessage(error, t, t("admin.programs.staffSaveError")),
        );
        delete form.dataset.saving;
        save.disabled = false;
        cancel.disabled = false;
        return;
      }
      if (emailRequested && assignedMembership) {
        const release = beginEnrollmentRequest(this, "site", siteId);
        try {
          if (!release) throw new Error("enrollment_request_pending");
          const sent = await adminApi.createManagerGrant(
            siteId,
            assignedMembership.membershipId,
            "link",
          );
          if (sent.grant?.deliveryStatus !== "accepted")
            throw new Error("enrollment_email_failed");
          notifyAdmin("admin.enrollment.emailed", "success");
        } catch {
          notifyAdmin("admin.enrollment.createdEmailFailed", "error");
        } finally {
          release?.();
        }
      }
      form.closest("dialog")?.close();
      if (this.navigationGeneration !== creationGeneration) return;
      try {
        await this.openSite(siteId, false);
        this.querySelector(
          "#manager-membership-form [data-manager-search]",
        )?.focus();
      } catch (error) {
        feedback.failure(error);
        this.state.error = error.message;
        this.render();
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  async addManagerMembership(form) {
    const feedback = actionFeedback("admin.toast.managerAssigned");
    try {
      if (!this.state.site) return;
      const data = new FormData(form);
      const user = this.state.availableSiteUsers.find(
        (item) => item.userId === formValue(data, "manager-user-id"),
      );
      if (!user?.email) throw new Error(t("admin.relationships.chooseManager"));
      if (user.personId)
        await adminApi.assignPersonToSite(this.state.site.siteId, user);
      else
        await adminApi.createManagerMembership(
          this.state.site.siteId,
          `${user.firstName} ${user.lastName}`.trim(),
          user.email,
          this.state.site.leadProgramId,
          user.userId,
        );
      feedback.success();
      this.state.managerDirectoryLoaded = false;
      this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
      form.reset();
      await this.openSite(this.state.site.siteId, false);
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  /** @param {HTMLFormElement} form */
  async saveWithFeedback(form, save) {
    return withSaveFeedback(form, save, {
      savingLabel: t("siteAdmin.edit.saving"),
      onError: (error) => showFormSaveError(form, adminErrorMessage(error, t)),
    });
  },
  async saveSiteManager(form) {
    return this.saveWithFeedback(form, () => this.persistSiteManager(form));
  },
  async persistSiteManager(form) {
    const feedback = actionFeedback("admin.toast.managerSaved");
    try {
      const origin = location.pathname + location.search;
      const data = new FormData(form);
      const current = this.state.siteManager;
      if (!current || current.personId)
        return this.persistPersonManager(form, current, feedback);
      const canManageAssignments =
        this.state.capabilities.createEntities === true;
      const programId = canManageAssignments
        ? formValue(data, "manager-program-id")
        : current?.programId || "";
      const programChanged = Boolean(
        current && current.programId !== programId,
      );
      const values = {
        firstName: formValue(data, "manager-first-name"),
        lastName: formValue(data, "manager-last-name"),
        phone: formValue(data, "manager-phone"),
        phoneExtension: formValue(data, "manager-phone-extension"),
        email: canManageAssignments
          ? formValue(data, "manager-email")
          : current?.email || "",
        siteManager: true,
      };
      const siteIds = canManageAssignments
        ? data.getAll("manager-site-id").map(String)
        : (current?.assignedSites || []).map((site) => site.siteId);
      const fullName = `${values.firstName} ${values.lastName}`.trim();
      try {
        let response;
        if (programChanged) {
          const targetProgram = await adminApi.getProgram(programId);
          const targetUser = (targetProgram.users || []).find(
            (user) =>
              user.status !== "inactive" &&
              String(user.email || "").toLowerCase() ===
                values.email.toLowerCase(),
          );
          response = targetUser
            ? await adminApi.updateProgramUser(
                programId,
                targetUser.userId,
                values,
              )
            : await adminApi.createProgramUser(programId, values);
        } else {
          response = current
            ? await adminApi.updateProgramUser(
                programId,
                current.userId,
                values,
              )
            : await adminApi.createProgramUser(programId, values);
        }
        feedback.changed();
        const user = response.user;
        const existing = new Map(
          (current?.assignedSites || []).map((site) => [site.siteId, site]),
        );
        const selected = new Set(siteIds);
        const savedAssignments = new Map(existing);
        // Assignment counts belong to this one staff record. Apply Site changes
        // serially so each transaction observes the count written by the last.
        for (const siteId of siteIds) {
          const membership = existing.get(siteId);
          if (membership?.legacyAssignment && !canManageAssignments) continue;
          if (membership && !membership.legacyAssignment) {
            const result = await adminApi.updateManagerMembership(
              siteId,
              membership.membershipId,
              fullName,
              values.email,
            );
            savedAssignments.set(siteId, {
              ...membership,
              ...result.membership,
            });
          } else {
            const result = await adminApi.createManagerMembership(
              siteId,
              fullName,
              values.email,
              programId,
              user.userId,
            );
            savedAssignments.set(siteId, { ...result.membership, siteId });
          }
        }
        for (const [siteId, membership] of existing) {
          if (selected.has(siteId)) continue;
          if (membership.legacyAssignment)
            await adminApi.unassignSiteUser(siteId, membership.userId);
          else
            await adminApi.deactivateManagerMembership(
              siteId,
              membership.membershipId,
            );
        }
        if (programChanged) {
          await adminApi.updateProgramUser(current.programId, current.userId, {
            ...values,
            siteManager: false,
          });
        }
        const program = this.state.programs.find(
          (item) => item.programId === programId,
        );
        const savedManager = {
          ...user,
          programId,
          programName: program?.name || "",
          providerId: program?.providerId || "",
          assignedSites: siteIds.map((siteId) => ({
            ...savedAssignments.get(siteId),
            siteId,
            siteName:
              this.state.sites.find((site) => site.siteId === siteId)?.name ||
              "",
          })),
        };
        this.state.siteManagers = upsertRecord(
          this.state.siteManagers.filter(
            (manager) => !programChanged || manager.userId !== current.userId,
          ),
          savedManager,
          "userId",
        );
        feedback.success();
        this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
        this.state.managerDirectoryLoaded = false;
        this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
        if (location.pathname + location.search !== origin) return true;
        this.state.siteManager = savedManager;
        this.state.siteSaveMessage = "";
        this.state.siteSaveError = "";
        if (form.dataset?.returnSite) {
          form.dataset.isDirty = "false";
          navigate(
            `/sites/${encodeURIComponent(form.dataset.returnSite)}?section=details`,
          );
          return true;
        }
        if (!current || user.userId !== current.userId) {
          window.history.replaceState(
            {},
            "",
            `/managers/${encodeURIComponent(user.userId)}`,
          );
        }
        this.render();
        return true;
      } catch (error) {
        feedback.failure(error);
        showFormSaveError(form, managerSaveErrorMessage(error));
        return false;
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  async persistPersonManager(form, current, feedback) {
    const origin = location.pathname + location.search;
    const data = new FormData(form);
    const supervisor = this.state.capabilities.createEntities;
    const values = {
      firstName: formValue(data, "manager-first-name"),
      lastName: formValue(data, "manager-last-name"),
      email: supervisor ? formValue(data, "manager-email") : current.email,
      phone: formValue(data, "manager-phone"),
      phoneExtension: formValue(data, "manager-phone-extension"),
      ...(supervisor
        ? {
            primaryProviderId: formValue(data, "manager-provider-id"),
            primaryProgramId: formValue(data, "manager-program-id"),
          }
        : {}),
    };
    const id = current?.personId || form.dataset.createdPersonId;
    const { person } = id
      ? await adminApi.updatePerson(id, values)
      : await adminApi.createPerson(values);
    form.dataset.createdPersonId = person.personId;
    feedback.changed();
    const selected = supervisor
      ? data.getAll("manager-site-id").map(String)
      : (current?.assignedSites || []).map((s) => s.siteId);
    const existing = (form.confirmedAssignments ||= new Map(
      (current?.assignedSites || []).map((s) => [s.siteId, s]),
    ));
    for (const siteId of selected) {
      if (existing.has(siteId)) continue;
      // Reconcile a prior uncertain write before retrying; never create twice.
      const { memberships = [] } =
        await adminApi.listManagerMemberships(siteId);
      let membership = memberships.find(
        (m) => m.personId === person.personId && m.status !== "inactive",
      );
      if (!membership)
        membership = (await adminApi.assignPersonToSite(siteId, person))
          .membership;
      const site = this.state.sites.find((s) => s.siteId === siteId);
      existing.set(siteId, {
        ...membership,
        siteId,
        siteName: site?.name,
        leadProgramId: site?.leadProgramId,
      });
    }
    for (const [siteId, membership] of existing) {
      if (selected.includes(siteId)) continue;
      try {
        await adminApi.deactivateManagerMembership(
          siteId,
          membership.membershipId,
        );
      } catch (error) {
        // Another editor may already have completed this exact removal.
        if (
          error.status !== 404 ||
          error.message !== "manager_membership_not_found"
        )
          throw error;
      }
      existing.delete(siteId);
    }
    this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
    const assignedSites = [...existing.values()];
    const manager = {
      ...current,
      ...person,
      userId: person.personId,
      programId: person.primaryProgramId || "",
      providerId: person.primaryProviderId || "",
      programName:
        this.state.programs.find((p) => p.programId === person.primaryProgramId)
          ?.name || "",
      assignedSites,
    };
    this.state.people = upsertRecord(
      this.state.people || [],
      person,
      "personId",
    );
    this.state.siteManagers = upsertRecord(
      this.state.siteManagers,
      manager,
      "userId",
    );
    this.state.sites = this.state.sites.map((site) => ({
      ...site,
      managerMemberships: [
        ...(site.managerMemberships || []).filter(
          (m) =>
            m.personId !== person.personId &&
            m.userId !== person.personId &&
            !(current?.legacyUserIds || []).includes(m.userId),
        ),
        ...assignedSites
          .filter((m) => m.siteId === site.siteId)
          .map((m) => ({ ...m, ...person, userId: person.personId })),
      ],
    }));
    feedback.success();
    form.dataset.isDirty = "false";
    if (location.pathname + location.search !== origin) return true;
    if (form.dataset.returnSite) {
      navigate(
        `/sites/${encodeURIComponent(form.dataset.returnSite)}?section=details`,
      );
      return true;
    }
    window.history.replaceState(
      {},
      "",
      `/managers/${encodeURIComponent(person.personId)}`,
    );
    this.state.siteManager = manager;
    this.render();
    return true;
  },
  async removeSiteManager() {
    const feedback = actionFeedback("admin.toast.managerDeleted");
    try {
      const manager = this.state.siteManager;
      const returnSite = new URLSearchParams(window.location.search).get(
        "returnSite",
      );
      if (!manager) return;
      try {
        await adminApi.removeSiteManager(manager.programId, manager.userId);
        feedback.success();
        this.state.managerDirectoryLoaded = false;
        this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
        this.state.siteManager = null;
        const form = this.querySelector("#site-manager-record-form");
        if (form) form.dataset.isDirty = "false";
        const affected = new Set(
          (manager.assignedSites || []).map((site) => site.siteId),
        );
        this.state.sites = this.state.sites.map((site) => {
          if (!affected.has(site.siteId)) return site;
          const { managerMemberships, ...rest } = site;
          return rest;
        });
        await this.loadSiteManagers(true);
        navigate(
          returnSite
            ? `/sites/${encodeURIComponent(returnSite)}?section=details`
            : "/managers",
        );
      } catch (error) {
        feedback.failure(error);
        this.state.error =
          error instanceof Error &&
          [
            "site_primary_contact_in_use",
            "program_primary_contact_in_use",
          ].includes(error.message)
            ? t("admin.programs.reassignPrimaryBeforeRemoval")
            : error instanceof Error &&
                error.message === "manager_removal_conflict"
              ? "The manager or one of their Site assignments changed. Reload and try again."
              : "The manager could not be removed. Try again.";
        this.render();
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  /** @param {string} membershipId */
  async deactivateManagerMembership(membershipId) {
    const feedback = actionFeedback("admin.toast.managerRemoved");
    try {
      if (!this.state.site) return;
      const membership = this.state.managerMemberships.find(
        (item) => item.membershipId === membershipId,
      );
      const result = membership?.legacyAssignment
        ? {
            ...(await adminApi.unassignSiteUser(
              this.state.site.siteId,
              membership.userId,
            )),
            revokedBindingCount: 0,
          }
        : await adminApi.deactivateManagerMembership(
            this.state.site.siteId,
            membershipId,
          );
      feedback.success();
      this.state.managerDirectoryLoaded = false;
      this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
      const siteId = this.state.site.siteId;
      await this.openSite(siteId, false);
      this.state.revocationMessage = `${membership?.name || "Site Manager"} removed; ${result.revokedBindingCount} Manager binding${result.revokedBindingCount === 1 ? "" : "s"} revoked at this Site.`;
      this.render();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  /** @param {string} membershipId */
  openManagerMembershipRemoval(membershipId) {
    const membership = this.state.managerMemberships.find(
      (item) => item.membershipId === membershipId,
    );
    if (!membership) return;
    this.state.managerMembershipRemovalTarget = membership;
    this.render();
    this.querySelector("#remove-manager-membership-dialog")?.showModal();
  },

  /** @param {string} membershipId */
  async showEnrollmentCode(scope, membershipId) {
    const id =
      scope === "site"
        ? this.state.site?.siteId
        : this.state.provider?.providerId;
    if (!id) return;
    const release = beginEnrollmentRequest(this, scope, id);
    if (!release) return;
    const view = (this.state.enrollmentCodeView ||= { codes: new Map() });
    const generation = this.navigationGeneration;
    const current = () =>
      this.state.enrollmentCodeView === view &&
      this.navigationGeneration === generation;
    this.render();
    try {
      if (scope === "site") {
        const member = this.state.managerMemberships.find(
          (m) => m.membershipId === membershipId,
        );
        if (member?.legacyAssignment) {
          const linked = await adminApi.createManagerMembership(
            id,
            member.name,
            member.email,
            this.state.site.leadProgramId,
            member.userId,
          );
          if (!current()) return;
          membershipId = linked.membership.membershipId;
          this.state.managerMemberships = this.state.managerMemberships.map(
            (m) => (m === member ? linked.membership : m),
          );
        }
      }
      const result =
        scope === "site"
          ? await adminApi.createManagerGrant(id, membershipId, "screen")
          : await adminApi.createProviderManagerGrant(
              id,
              membershipId,
              "screen",
            );
      if (!current()) return;
      view.codes.set(result.grant.grantId, {
        scope,
        id,
        grant: result.grant,
        code: result.enrollmentCode,
      });
      const field =
        scope === "site" ? "managerGrants" : "providerManagerGrants";
      this.state[field] = upsertRecord(
        this.state[field].map((grant) =>
          scope === "site" &&
          grant.membershipId === membershipId &&
          grant.status === "pending" &&
          grant.issuedBy !== "manager-email-recovery" &&
          Date.parse(grant.expiresAt) > Date.now()
            ? { ...grant, status: "replaced" }
            : grant,
        ),
        result.grant,
        "grantId",
      );
      // Site issuance replaces older pending grants for this membership.
      for (const [grantId, entry] of view.codes) {
        if (
          entry.scope === scope &&
          entry.id === id &&
          entry.grant.membershipId === membershipId &&
          grantId !== result.grant.grantId
        )
          view.codes.delete(grantId);
      }
      this.render();
      this.querySelector(
        `[data-enrollment-code="${CSS.escape(result.grant.grantId)}"]`,
      )?.focus();
    } catch (error) {
      if (current())
        notifyAdmin(
          error.message === "provider_manager_grant_already_active"
            ? "admin.enrollment.alreadyActive"
            : "admin.enrollment.screenFailed",
          "error",
        );
    } finally {
      release();
    }
  },

  async issueManagerGrant(membershipId, deliveryMode = "link") {
    const release = beginEnrollmentRequest(
      this,
      "site",
      this.state.site?.siteId,
    );
    if (!release) return;
    if (this.state.error) {
      this.state.error = "";
      this.render();
    }
    const feedback = actionFeedback("admin.enrollment.emailed");
    try {
      if (!this.state.site) return;
      const membership = this.state.managerMemberships.find(
        (item) => item.membershipId === membershipId,
      );
      if (membership?.legacyAssignment) {
        const linked = await adminApi.createManagerMembership(
          this.state.site.siteId,
          membership.name,
          membership.email,
          this.state.site.leadProgramId,
          membership.userId,
        );
        feedback.changed();
        membershipId = linked.membership.membershipId;
        this.state.managerMemberships = this.state.managerMemberships.map(
          (item) => (item === membership ? linked.membership : item),
        );
        this.render();
      }
      const created = await adminApi.createManagerGrant(
        this.state.site.siteId,
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
        (await this.refreshSiteAccess(this.state.site.siteId, false)) === false
      )
        return;
      this.state.managerGrants = attachCreatedEnrollmentUrl(
        this.state.managerGrants,
        created,
      );
      this.render();
    } catch (error) {
      if (error.message === "provider_manager_grant_already_active") {
        error.message = t("admin.enrollment.alreadyActive");
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

  /** @param {HTMLButtonElement} button */
  async copyManagerGrant(button) {
    const enrollmentUrl = dataAttr(button, "data-copy-enrollment-url");
    const status = button.parentElement?.querySelector("[data-copy-status]");
    const icon = button.querySelector("wa-icon");
    button.disabled = true;
    try {
      await copyEnrollmentUrl(enrollmentUrl);
      button.setAttribute("aria-label", "Enrollment link copied");
      icon?.setAttribute("name", "check");
      if (status) status.textContent = "Enrollment link copied.";
    } catch {
      notifyAdmin("admin.toast.copyFailed", "error");
      button.setAttribute("aria-label", "Copy enrollment link failed");
      if (status)
        status.textContent = "The enrollment link could not be copied.";
    } finally {
      button.disabled = false;
    }
  },
  /** @param {string} grantId */
  async cancelManagerGrant(grantId) {
    const feedback = actionFeedback("admin.toast.linkCancelled");
    try {
      if (!this.state.site) return;
      await adminApi.cancelManagerGrant(this.state.site.siteId, grantId);
      feedback.success();
      if ((await this.refreshSiteAccess(this.state.site.siteId)) === false)
        return;
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
};
