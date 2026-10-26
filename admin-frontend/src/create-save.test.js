import { siteManagerRoster } from "./site-managers.js";
import { adminErrorMessage } from "./admin-error-messages.js";
import { createActionFeedback } from "./action-feedback-core.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { upsertRecord } from "./save-feedback.js";
const en = JSON.parse(
  readFileSync(
    new URL("../../frontend/src/i18n/catalogs/en.json", import.meta.url),
    "utf8",
  ),
);
const t = (key) => en[key] ?? key;

test("form errors explain duplicate programs and hide generic API codes", async () => {
  const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
  const start = source.indexOf("  async saveWithFeedback(form, save)");
  const end = source.indexOf("\n  }", start) + 4;
  for (const [code, key] of [
    ["program_already_exists", "admin.programs.duplicateHelp"],
    ["provider_already_exists", "admin.errors.providerExists"],
    ["site_already_exists", "admin.errors.siteExists"],
    ["provider_manager_already_assigned", "admin.errors.staffAssigned"],
    ["valid_email_required", "admin.errors.emailRequired"],
    ["admin_request_failed", "admin.toast.requestFailed"],
    ["staff_source_changed", "admin.programs.staffSourceChanged"],
  ]) {
    let message;
    const form = {};
    const Subject = vm.runInNewContext(`(class{${source.slice(start, end)}})`, {
      t,
      adminErrorMessage,
      withSaveFeedback: async (actualForm, save, { onError }) => {
        assert.equal(actualForm, form);
        try {
          await save();
        } catch (error) {
          onError(error);
        }
      },
      showFormSaveError: (actualForm, text) => {
        assert.equal(actualForm, form);
        message = text;
      },
    });
    await new Subject().saveWithFeedback(form, async () => {
      throw new Error(code);
    });
    assert.equal(message, t(key));
  }
});

for (const kind of ["Provider", "Program"]) {
  test(`${kind} creation uses its confirmed response without a directory reload`, async () => {
    const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
    const start = source.indexOf(`  async create${kind}(form)`);
    const end = source.indexOf("\n  }", start) + 4;
    const destinations = [];
    let mutations = 0;
    const record =
      kind === "Provider"
        ? { providerId: "new", name: "New" }
        : { programId: "new", providerId: "provider", name: "New" };
    const context = vm.createContext({
      upsertRecord,
      URLSearchParams,
      location: { pathname: `/${kind.toLowerCase()}s/new`, search: "" },
      window: { location: { search: "" } },
      FormData: class {
        get(name) {
          return name === "program-staff"
            ? encodeURIComponent(
                JSON.stringify({
                  firstStaff: {
                    firstName: "Test",
                    lastName: "Person",
                    email: "test@example.org",
                  },
                }),
              )
            : "New";
        }
      },
      actionFeedback: (key) =>
        createActionFeedback(
          key,
          () => ({ close() {} }),
          (key) => key,
        ),
      adminApi: {
        [`create${kind}`]: async () => {
          mutations++;
          return { [kind.toLowerCase()]: record };
        },
      },
      navigate: (path) => destinations.push(path),
    });
    const Subject = vm.runInContext(
      `(class{${source.slice(start, end)} async loadDirectory(){throw new Error('Unexpected global reload');}})`,
      context,
    );
    const app = new Subject();
    app.state = { providers: [], programs: [] };
    await app[`create${kind}`]({ querySelector: () => ({ disabled: false }) });
    assert.equal(mutations, 1);
    assert.equal(app.state[`${kind.toLowerCase()}s`][0].name, "New");
    assert.deepEqual(destinations, [`/${kind.toLowerCase()}s/new`]);
  });
}

for (const [staff, disabled] of [
  ["", false],
  ["__create__", false],
  [encodeURIComponent("{}"), false],
  [encodeURIComponent('{"existingStaff":{"userId":"one"}}'), true],
]) {
  test(`program creation rejects missing or loading staff (${staff}, ${disabled})`, async () => {
    const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
    const start = source.indexOf("  async createProgram(form)");
    const end = source.indexOf("\n  }", start) + 4;
    let calls = 0;
    const Subject = vm.runInNewContext(`(class{${source.slice(start, end)}})`, {
      location: { pathname: "/programs/new", search: "" },
      window: { location: { search: "" } },
      URLSearchParams,
      FormData: class {
        get(key) {
          return key === "program-staff" ? staff : "New";
        }
      },
      t: (key) => key,
      actionFeedback: (key) =>
        createActionFeedback(
          key,
          () => ({ close() {} }),
          (key) => key,
        ),
      adminApi: {
        createProgram: () => {
          calls++;
        },
      },
    });
    await assert.rejects(
      new Subject().createProgram({ querySelector: () => ({ disabled }) }),
      /admin.programs.chooseStaff/,
    );
    assert.equal(calls, 0);
  });
}

for (const scenario of [
  "success",
  "repair",
  "failure",
  "navigated away",
  "existing membership",
]) {
  test(`site creation navigates without directory reloads: ${scenario}`, async () => {
    const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
    const start = source.indexOf("  async createSiteFromFlow(form)");
    const end = source.indexOf("\n  }", start) + 4;
    const events = [];
    const location = { pathname: "/sites/new", search: "?programId=program" };
    const savedSite = {
      siteId: "new/site",
      name: "New site",
      addressParts: { street: "Main" },
      publicContact: { email: "test@example.org" },
      primaryContactUserId: "staff",
    };
    const membership = {
      membershipId: "confirmed",
      userId: "staff",
      name: "Sam Lee",
      status: "active",
    };
    const Subject = vm.runInNewContext(`(class{${source.slice(start, end)}})`, {
      siteManagerRoster,
      siteSaveErrorMessage: () => "Save failed",
      location,
      upsertRecord,
      FormData: class {},
      formValue: (_, name) =>
        ({ "site-manager-user-id": "staff" })[name] || name,
      controlValue: () => "test",
      addressPartsFromForm: () => savedSite.addressParts,
      formatAddressParts: () => "Main",
      actionFeedback: () => ({
        changed() {},
        success() {
          events.push("success");
        },
        failure() {
          events.push("failure");
        },
      }),
      adminApi: {
        async createSite() {
          if (scenario === "failure") throw new Error("save_failed");
          if (scenario === "navigated away") {
            location.pathname = "/providers";
            app.state.newSiteUsers = [];
          }
          return {
            site:
              scenario === "repair" ? { siteId: savedSite.siteId } : savedSite,
          };
        },
        async assignSiteUser() {
          events.push("repair assignment");
        },
        async updateSite() {
          events.push("repair details");
          return { site: savedSite };
        },
        async listManagerMemberships() {
          return {
            memberships: scenario === "existing membership" ? [membership] : [],
          };
        },
        async createManagerMembership() {
          events.push("membership saved");
          return { membership };
        },
      },
      navigate(path) {
        events.push(path);
      },
    });
    const app = new Subject();
    const existing = { siteId: "existing" };
    app.state = {
      sites: [existing],
      newSiteUsers: [{ userId: "staff", firstName: "Sam", lastName: "Lee" }],
      managerDirectoryLoaded: true,
    };
    app.render = () => events.push("render destination loading");
    app.querySelector = () => ({
      focus() {
        events.push("focus loading");
      },
    });
    app.loadDirectory = app.loadSiteManagers = () => {
      throw new Error("Unexpected global reload");
    };
    if (scenario === "failure") {
      await assert.rejects(app.createSiteFromFlow({}), /save_failed/);
      assert.deepEqual(events, ["failure"]);
      assert.equal(app.state.sites.length, 1);
      return;
    }
    await app.createSiteFromFlow({});
    assert.equal(app.state.sites[0], existing);
    assert.equal(app.state.sites[1].siteId, savedSite.siteId);
    assert.deepEqual(app.state.sites[1].managerMemberships, [membership]);
    assert.equal(app.state.managerDirectoryLoaded, false);
    if (scenario === "existing membership")
      assert.ok(!events.includes("membership saved"));
    else
      assert.ok(events.indexOf("membership saved") < events.indexOf("success"));
    if (scenario === "navigated away") {
      assert.deepEqual(events, ["membership saved", "success"]);
    } else {
      assert.deepEqual(events.slice(-3), [
        "/sites/new%2Fsite",
        "render destination loading",
        "focus loading",
      ]);
      assert.equal(app.state.site, null);
    }
  });
}

for (const detached of [false, true]) {
  for (const [status, code] of [
    [400, "invalid_public_contact"],
    [422, "invalid_public_contact"],
    [409, "site_already_exists"],
    [500, "internal_error"],
  ]) {
    test(`pending site failure ${status} with detached=${detached} has visible feedback once`, async () => {
      const source = readFileSync(
        new URL("./main.js", import.meta.url),
        "utf8",
      );
      const start = source.indexOf("  async createSiteFromFlow(form)");
      const end = source.indexOf("\n  }", start) + 4;
      const notices = [];
      const feedback = createActionFeedback(
        "admin.toast.siteCreated",
        (notice) => notices.push(notice),
        t,
      );
      let rejectSave;
      const pending = new Promise((_, reject) => {
        rejectSave = reject;
      });
      const Subject = vm.runInNewContext(
        `(class{${source.slice(start, end)}})`,
        {
          location: { pathname: "/sites/new", search: "" },
          FormData: class {},
          formValue: () => "staff",
          controlValue: () => "test",
          addressPartsFromForm: () => ({}),
          formatAddressParts: () => "Main",
          actionFeedback: () => feedback,
          siteSaveErrorMessage: () => t("admin.errors.staffContact"),
          adminApi: { createSite: () => pending },
        },
      );
      const app = new Subject();
      app.state = { newSiteUsers: [] };
      const form = { isConnected: true };
      const saved = app.createSiteFromFlow(form);
      form.isConnected = !detached;
      const error = Object.assign(new Error(code), { status });
      rejectSave(error);
      await assert.rejects(saved, error);
      // The operation owns the toast; repeated reporting cannot duplicate it.
      feedback.failure(error);
      assert.equal(
        notices.length,
        detached || ![400, 422].includes(status) ? 1 : 0,
      );
      if (detached && (status === 400 || status === 422))
        assert.equal(notices[0].message, t("admin.errors.staffContact"));
      if (status === 409)
        assert.equal(notices[0].title, t("admin.errors.siteExistsTitle"));
    });
  }
}
