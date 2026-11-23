// Setup codes and enrollment links, which the Site and Provider pages both show.
import { notifyAdmin } from "../action-feedback.js";
import { adminApi } from "../services/admin-api.js";
import { copyEnrollmentUrl } from "../enrollment-links.js";
import { beginEnrollmentRequest } from "../enrollment-request.js";
import { dataAttr } from "../dom.js";
import { upsertRecord } from "../save-feedback.js";

/** Shows a one-time setup code on screen. The Site page mixes it in; the Provider page's binding calls it. */
export const enrollmentCodeActions = {
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
    const visit = this.visit;
    const current = () =>
      this.state.enrollmentCodeView === view && this.visit === visit;
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
};

/** @param {HTMLButtonElement} button */
export async function copyEnrollmentLink(button) {
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
    if (status) status.textContent = "The enrollment link could not be copied.";
  } finally {
    button.disabled = false;
  }
}
