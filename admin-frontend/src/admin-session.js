// The signed-in admin's role and profile, read once by <admin-app> and passed to its pages.
import { adminApi } from "./services/admin-api.js";

/** A session with its own role and profile, so a page test can seed one without touching another's. */
export function createAdminSession() {
  let role = "";
  /** @type {Record<string, boolean>} */
  let capabilities = {};
  /** @type {any | null} */
  let profile = null;
  // Bumped by clear() and seed(), so a session read that finishes after them is dropped.
  let generation = 0;

  return {
    /**
     * A Site's unsent compliance period form, kept while the user adds a phone on
     * My profile, so the Site page can reopen it and <admin-app> can offer to resume it.
     * @type {ReturnType<typeof import("./compliance-profile-draft.js").captureComplianceDraft> | null}
     */
    complianceDraft: null,
    get role() {
      return role;
    },
    get capabilities() {
      return capabilities;
    },
    get profile() {
      return profile;
    },
    /** @returns {Promise<void>} */
    async load() {
      const started = generation;
      const session = await adminApi.getSession();
      if (started !== generation) return;
      // Set before the profile read, so a failed read still knows the role.
      role = session.role || "";
      capabilities = session.capabilities || {};
      if (role !== "compliance-manager") {
        profile = null;
        return;
      }
      const { profile: next } = await adminApi.getMyProfile();
      if (started === generation) profile = next;
    },
    /** @param {any | null} next */
    setProfile(next) {
      profile = next;
    },
    clear() {
      generation++;
      this.complianceDraft = null;
      role = "";
      capabilities = {};
      profile = null;
    },
    /** @param {{ role?: string, capabilities?: Record<string, boolean>, profile?: any }} values */
    seed(values) {
      generation++;
      role = values.role || "";
      capabilities = values.capabilities || {};
      profile = values.profile ?? null;
    },
  };
}

/** @typedef {ReturnType<typeof createAdminSession>} AdminSession */
