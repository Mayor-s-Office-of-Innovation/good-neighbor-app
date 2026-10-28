import { adminApi } from "./services/admin-api.js";
import { escapeHtml as e } from "./dom.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { formatDateTime } from "../../frontend/src/i18n/dates.js";
import {
  PolicyEditStack,
  newCategory,
  newRule,
  setPolicyField,
  policyTranslationFields,
  invalidatePolicyTranslations,
} from "./policy-editor-model.js";
import "./policy-editor.css";

const text = (key, params = {}) => e(t(`admin.policy.${key}`, params));
const button = (id, key, disabled = false) =>
  `<button type="button" class="${id === "policy-save" ? "btn-primary" : "btn-secondary"}" id="${id}" ${disabled ? "disabled" : ""}>${text(key)}</button>`;
const input = (path, key, value, type = "text") =>
  `<wa-input label="${text(key)}" data-path="${e(path)}" ${type === "number" ? 'type="number" step="any"' : `type="${type}"`} value="${e(value === null ? "" : String(value))}"></wa-input>`;
const area = (path, key, value) =>
  `<wa-textarea label="${text(key)}" data-path="${e(path)}" value="${e(value)}" rows="3"></wa-textarea>`;
const select = (path, key, value, options) =>
  `<wa-select label="${text(key)}" data-path="${e(path)}" value="${e(String(value))}">${options.map(([v, label]) => `<wa-option value="${e(v)}">${e(label)}</wa-option>`).join("")}</wa-select>`;
const check = (path, key, value) =>
  `<wa-checkbox data-path="${e(path)}" ${value ? "checked" : ""}>${text(key)}</wa-checkbox>`;
const clock = (n) =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

class PolicyEditor extends HTMLElement {
  document = null;
  navigation = new PolicyEditStack();
  openHelp = new Set();
  revision = 0;
  categoryId = "";
  ruleId = "";
  report = null;
  preview = null;
  releases = [];
  dirty = false;
  busy = false;
  error = "";
  message = "";
  reason = "";
  search = "";
  includeTranslations = false;
  scenario = { severity: 1, reportedAt: new Date().toISOString(), answers: {} };
  beforeUnload = (event) => {
    if (this.dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  guardNavigation = (event) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !event.target.closest?.("a[data-route]")
    )
      return;
    if (!this.confirmLeave()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  /** The parent router calls this before unmounting the editor on history changes. */
  confirmLeave() {
    if (this.busy && this.navigation.editing) return false;
    if (this.dirty && !window.confirm(t("admin.policy.discard"))) return false;
    this.dirty = false;
    return true;
  }
  connectedCallback() {
    this.pageUrl = location.pathname + location.search;
    window.addEventListener("beforeunload", this.beforeUnload);
    document.addEventListener("click", this.guardNavigation, true);
    this.addEventListener("change", (event) => this.change(event));
    this.addEventListener("input", (event) => this.change(event, false));
    this.addEventListener("click", (event) => this.click(event));
    this.load();
  }
  disconnectedCallback() {
    window.removeEventListener("beforeunload", this.beforeUnload);
    document.removeEventListener("click", this.guardNavigation, true);
  }
  async load() {
    await this.run(async () => {
      const [response, history] = await Promise.all([
        adminApi.getPolicyDraft(),
        adminApi.listPolicyReleases(),
      ]);
      if (!this.isConnected) return;
      this.navigation = new PolicyEditStack();
      this.document = response.draft.document;
      this.revision = response.draft.revision;
      this.referenceRules = structuredClone(this.document.rules);
      this.activeVersion = response.activeVersion;
      this.releases = history.releases.sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      this.historyTruncated = history.truncated;
      this.categoryId = this.document.categories[0]?.id ?? "";
      this.dirty = false;
      this.report = null;
    });
  }
  async run(fn) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    this.message = "";
    this.render();
    try {
      await fn();
    } catch (error) {
      if (error.report) this.report = error.report;
      this.error =
        error.message === "policy_base_changed"
          ? t("admin.policy.baseChanged")
          : error.status === 409
            ? t("admin.policy.conflict")
            : t("admin.policy.requestFailed");
    } finally {
      this.busy = false;
      if (this.isConnected) {
        this.render();
        this.focusControl("#policy-view-title");
      }
    }
  }
  changed() {
    this.dirty = true;
    this.report = null;
    this.preview = null;
    this.message = "";
    const rule = this.document?.rules.find((r) => r.id === this.ruleId);
    if (rule)
      this.querySelectorAll("[data-task-preview]").forEach((node) => {
        node.textContent = rule[node.dataset.taskPreview] ?? "";
      });
    this.querySelector("#policy-validation")?.remove();
    this.querySelector("#policy-scenario-result")?.remove();
    const status = this.querySelector("#policy-save-state");
    if (status) status.textContent = t("admin.policy.unsaved");
    const release = this.querySelector("#policy-release");
    if (release) release.disabled = true;
  }
  change(event, renderChanges = true) {
    const target = event.target;
    if (!this.document) return;
    if (
      !renderChanges &&
      (!["WA-INPUT", "WA-TEXTAREA"].includes(target.tagName) ||
        !(
          target.dataset.path ||
          target.dataset.translation ||
          target.id === "policy-reason"
        ))
    )
      return;
    if (target.dataset.path) {
      const path = target.dataset.path;
      let value =
        target.tagName === "WA-CHECKBOX" ? target.checked : target.value;
      if (target.type === "number") value = value === "" ? null : Number(value);
      if (path.endsWith("/aliases") || path.endsWith("/overrides"))
        value = value
          .split("\n")
          .map((v) => v.trim())
          .filter(Boolean);
      if (path.endsWith("/answer")) value = value === "true";
      if (path.endsWith("/start") || path.endsWith("/end")) {
        const [h, m] = value.split(":").map(Number);
        value = h * 60 + m;
      }
      if (path.endsWith("/actionType")) {
        const rule = this.document.rules.find((r) => r.id === this.ruleId);
        const defaults = ["site", "phone", "ticket"].map((type) =>
          t(`admin.policy.defaultButton.${type}`),
        );
        if (!rule.button || defaults.includes(rule.button))
          rule.button = t(`admin.policy.defaultButton.${value}`);
      }
      setPolicyField(this.document, path, value);
      const [collection, index, field] = path.split("/");
      const record = this.document[collection]?.[index];
      if (record) {
        const scope =
          collection === "categories"
            ? "category"
            : collection === "rules"
              ? "rule"
              : "question";
        invalidatePolicyTranslations(
          this.document,
          `${scope}.${record.id}.${field}`,
        );
      }
      if (collection === "questions" && field === "prompt") {
        this.querySelector('[data-path$="/questionId"]')
          ?.querySelectorAll("wa-option")
          .forEach((option) => {
            if (option.value === record.id)
              option.textContent =
                record.prompt || t("admin.policy.untitledQuestion");
          });
      }
      this.changed();
      if (
        renderChanges &&
        (["questionId", "actionType", "always"].includes(field) ||
          path.endsWith("/always"))
      )
        this.render();
    } else if (target.dataset.day) {
      const rule = this.document.rules.find((r) => r.id === this.ruleId);
      const day = Number(target.dataset.day) - 1;
      rule.schedule.days = target.checked
        ? [...rule.schedule.days, day].sort()
        : rule.schedule.days.filter((d) => d !== day);
      this.changed();
    } else if (target.dataset.translation) {
      const locale = target.dataset.locale;
      (this.document.translations[locale] ??= {})[target.dataset.translation] =
        target.value;
      this.changed();
    } else if (target.id === "policy-agency-preset") {
      const [agency, phone, agencyCode] = JSON.parse(target.value);
      const rule = this.document.rules.find((r) => r.id === this.ruleId);
      Object.assign(rule, { agency, agencyCode, ...(phone ? { phone } : {}) });
      this.changed();
      this.render();
    } else if (target.id === "policy-routing-preset") {
      this.document.rules.find((r) => r.id === this.ruleId).routing =
        target.value;
      this.changed();
      this.render();
    } else if (target.id === "policy-category") {
      this.categoryId = target.value;
      this.ruleId = "";
      this.render();
    } else if (target.id === "policy-rule") {
      this.ruleId = target.value;
      this.render();
    } else if (target.id === "policy-reason") this.reason = target.value;
    else if (target.id === "policy-search") {
      this.search = target.value;
      this.render();
      this.focusControl("#policy-search");
    } else if (target.id === "policy-translations-check") {
      this.includeTranslations = target.checked;
      this.report = null;
      this.render();
    } else if (target.id === "scenario-severity")
      this.scenario.severity = Number(target.value);
    else if (target.id === "scenario-time")
      this.scenario.reportedAt = target.value;
    else if (target.dataset.question) {
      if (target.value === "unanswered")
        delete this.scenario.answers[target.dataset.question];
      else
        this.scenario.answers[target.dataset.question] =
          target.value === "true";
    }
  }
  async click(event) {
    const target = event.target.closest?.("button");
    if (!target) return;
    if (target.dataset.help) {
      const description = this.querySelector(
        `#${CSS.escape(target.dataset.help)}`,
      );
      const expanded = target.getAttribute("aria-expanded") !== "true";
      target.setAttribute("aria-expanded", String(expanded));
      description.hidden = !expanded;
      if (expanded) this.openHelp.add(description.id);
      else this.openHelp.delete(description.id);
      return;
    }
    if (this.busy) return;
    if (target.id === "policy-reload") {
      if (!this.dirty || window.confirm(t("admin.policy.discard")))
        await this.load();
      return;
    }
    if (!this.document) return;
    if (target.dataset.issueCategory) {
      this.openEdit(
        target.dataset.issueRule ? "rule" : "category",
        target.dataset.issueCategory,
        target.dataset.issueRule ?? "",
      );
      return;
    }
    if (target.dataset.download) {
      await this.run(async () =>
        download(
          `policy-${target.dataset.download}.json`,
          JSON.stringify(
            (await adminApi.getPolicyRelease(target.dataset.download)).package,
            null,
            2,
          ),
        ),
      );
      return;
    }
    if (target.dataset.editCategory) {
      this.openEdit("category", target.dataset.editCategory);
      return;
    }
    if (target.dataset.categoryRules) {
      this.navigation.push({
        kind: "rules",
        categoryId: target.dataset.categoryRules,
        ruleId: "",
      });
      this.syncView();
      return;
    }
    if (target.dataset.editRule) {
      this.openEdit("rule", this.categoryId, target.dataset.editRule);
      return;
    }
    switch (target.id) {
      case "policy-add-category":
        this.openEdit("category", "", "", true);
        break;
      case "policy-add-rule":
        this.openEdit("rule", this.categoryId, "", true);
        break;
      case "policy-cancel":
        this.cancelEdit();
        break;
      case "policy-back":
        if (this.navigation.editing) this.cancelEdit();
        else {
          this.navigation.back();
          this.syncView();
        }
        break;
      case "policy-add-question": {
        const q = { id: `q_${crypto.randomUUID()}`, prompt: "" };
        this.document.questions.push(q);
        this.document.rules.find((r) => r.id === this.ruleId).questionId = q.id;
        this.changed();
        this.render();
        break;
      }
      case "policy-remove-rule":
        if (!window.confirm(t("admin.policy.confirmRemoveRule"))) break;
        this.document.rules = this.document.rules.filter(
          (r) => r.id !== this.ruleId,
        );
        this.changed();
        this.message = t("admin.policy.removalPending");
        this.render();
        break;
      case "policy-remove-category":
        if (!window.confirm(t("admin.policy.confirmRemoveCategory"))) break;
        this.document.rules = this.document.rules.filter(
          (r) => r.categoryId !== this.categoryId,
        );
        this.document.categories = this.document.categories.filter(
          (c) => c.id !== this.categoryId,
        );
        this.changed();
        this.message = t("admin.policy.removalPending");
        this.render();
        break;
      case "policy-save":
        await this.run(async () => {
          const result = await adminApi.savePolicyDraft(
            this.document,
            this.revision,
          );
          this.document = result.draft.document;
          this.revision = result.draft.revision;
          this.report = null;
          this.dirty = false;
          this.message = t("admin.policy.saved");
          if (this.navigation.editing) {
            this.navigation.saved();
            this.syncView(false);
          }
        });
        break;
      case "policy-reload":
        if (!this.dirty || window.confirm(t("admin.policy.discard")))
          await this.load();
        break;
      case "policy-validate":
        await this.run(async () => {
          this.report = await adminApi.validatePolicy(
            this.document,
            this.includeTranslations,
          );
        });
        break;
      case "policy-preview":
        await this.run(async () => {
          const response = await adminApi.previewPolicy(this.document, {
            ...this.scenario,
            category: this.document.categories.find(
              (c) => c.id === this.categoryId,
            )?.name,
          });
          this.preview = response.result;
          this.previousPreview = response.previous;
        });
        break;
      case "policy-release":
        await this.run(async () => {
          const result = await adminApi.createPolicyRelease(
            this.revision,
            this.reason,
          );
          this.revision = result.revision;
          this.releases.unshift(result.release);
          this.message = t("admin.policy.prepared");
        });
        break;
      case "policy-export":
        download("policy-draft.json", JSON.stringify(this.document, null, 2));
        break;
      case "policy-import": {
        const json = this.querySelector("#policy-json-file").files[0];
        const categories = this.querySelector("#policy-categories-file")
            .files[0],
          rules = this.querySelector("#policy-rules-file").files[0];
        if (this.dirty && !window.confirm(t("admin.policy.discard"))) break;
        await this.run(async () => {
          let document;
          if ([json, categories, rules].some((file) => file?.size > 280000))
            throw new Error("file_too_large");
          if (json) {
            const imported = JSON.parse(await json.text());
            document = imported.document ?? imported;
          } else {
            if (!categories || !rules) throw new Error("missing_files");
            document = (
              await adminApi.importPolicy(
                await categories.text(),
                await rules.text(),
              )
            ).document;
          }
          // Server schema validation before replacing local work; this endpoint never persists.
          const report = await adminApi.validatePolicy(document);
          this.document = document;
          this.categoryId = document.categories[0]?.id ?? "";
          this.ruleId = "";
          this.changed();
          this.report = report;
        });
        break;
      }
    }
  }
  async focusControl(selector) {
    const control = this.querySelector(selector);
    if (!control) return;
    await control.updateComplete;
    if (control.isConnected) control.focus();
  }
  /** Keep explanations before the control, with independent keyboard-operable buttons. */
  enhanceFieldHelp() {
    const names = {
      questionId: "question",
      responseHours: "deadline",
      always: "allHours",
    };
    const ids = {
      "policy-search": "search",
      "policy-reason": "reason",
      "policy-translations-check": "checkTranslations",
      "policy-routing-preset": "routingPreset",
      "policy-agency-preset": "agencyPreset",
      "scenario-severity": "severity",
      "scenario-time": "reportedAt",
      "policy-json-file": "jsonFile",
      "policy-categories-file": "categoriesFile",
      "policy-rules-file": "rulesFile",
    };
    this.querySelectorAll(
      "wa-input,wa-select,wa-textarea,wa-checkbox,input[type=file]",
    ).forEach((control, index) => {
      const parts = (control.dataset.path ?? "").split("/");
      const field = parts.at(-1);
      const key = control.dataset.translation
        ? "translation"
        : control.dataset.question
          ? "scenarioAnswer"
          : control.dataset.day
            ? "day"
            : parts.includes("severityGuidance")
              ? `level${field}`
              : (names[field] ?? ids[control.id] ?? field);
      const checkbox = control.tagName === "WA-CHECKBOX";
      const native = control.tagName === "INPUT";
      const label =
        control.getAttribute("label") ??
        (native
          ? control.parentElement.firstChild.textContent.trim()
          : control.textContent.trim());
      const id = `policy-help-${(control.dataset.path ?? control.dataset.translation ?? control.id ?? index).replace(/[^a-zA-Z0-9_-]/g, "-")}-${control.dataset.locale ?? control.dataset.day ?? index}`;
      if (!control.id) control.id = `${id}-control`;
      const wrapper = document.createElement("div");
      wrapper.className = "policy-field";
      const heading = document.createElement("div");
      heading.className = "policy-field-heading";
      heading.innerHTML = `${checkbox ? "" : native ? `<label for="${e(control.id)}">${e(label)}</label>` : `<span aria-hidden="true">${e(label)}</span>`}<button type="button" class="btn-icon policy-info" data-help="${id}" aria-expanded="${this.openHelp.has(id)}" aria-controls="${id}" aria-label="${text("fieldInformation", { field: label })}"><wa-icon name="circle-info" aria-hidden="true"></wa-icon></button>`;
      const description = document.createElement("p");
      description.id = id;
      description.className = "policy-field-description";
      description.hidden = !this.openHelp.has(id);
      description.textContent = t(`admin.policy.help.${key}`);
      if (native) {
        control.parentElement.replaceWith(wrapper);
      } else control.before(wrapper);
      if (checkbox) {
        wrapper.append(heading, description);
        heading.prepend(control);
      } else if (native) wrapper.append(heading, description, control);
      else {
        // Use Web Awesome's visible label slot; the help button is a sibling,
        // never an interactive descendant of the control's label.
        heading.querySelector("span")?.remove();
        heading.classList.add("policy-help-overlay");
        const labelSlot = document.createElement("span");
        labelSlot.slot = "label";
        const title = document.createElement("span");
        title.textContent = label;
        labelSlot.append(title, description);
        control.append(labelSlot);
        control.classList.add("policy-help-control");
        wrapper.append(heading, control);
      }
      control.setAttribute("aria-describedby", id);
    });
  }
  syncView(render = true) {
    const view = this.navigation.current;
    this.categoryId = view.categoryId;
    this.ruleId = view.ruleId;
    this.preview = null;
    this.scenario.answers = {};
    if (render) {
      this.render();
      this.focusControl("#policy-view-title");
    }
  }
  openEdit(kind, categoryId = "", ruleId = "", create = false) {
    if (this.navigation.editing) return;
    this.report = null;
    this.navigation.begin(this.document, this.dirty, {
      kind,
      categoryId,
      ruleId,
    });
    if (create) {
      if (kind === "category") {
        const record = newCategory();
        this.document.categories.push(record);
        this.navigation.current.categoryId = record.id;
      } else {
        const record = newRule(categoryId);
        this.document.rules.push(record);
        this.navigation.current.ruleId = record.id;
      }
      this.changed();
    }
    this.syncView();
  }
  cancelEdit() {
    if (
      this.navigation.changed(this.document) &&
      !window.confirm(t("admin.policy.discard"))
    )
      return;
    const previous = this.navigation.cancel();
    this.document = previous.document;
    this.dirty = previous.dirty;
    this.report = null;
    this.error = "";
    this.syncView();
  }
  render() {
    const d = this.document,
      view = this.navigation.current;
    const editing = this.navigation.editing;
    const category = d?.categories.find((c) => c.id === view.categoryId);
    const rule = d?.rules.find((r) => r.id === view.ruleId);
    const title =
      view.kind === "categories"
        ? t("admin.policy.title")
        : view.kind === "rules"
          ? t("admin.policy.rulesFor", {
              category: category?.name || t("admin.policy.untitled"),
            })
          : view.kind === "category"
            ? t("admin.policy.editCategory")
            : t("admin.policy.editRule");
    this.innerHTML = `<section class="policy-page" aria-busy="${this.busy}">
      <nav class="policy-breadcrumb" aria-label="${text("navigation")}">${view.kind !== "categories" ? button("policy-back", editing ? "backToTable" : "backToCategories", this.busy) : ""}<span>${text("title")}${category ? ` / ${e(category.name || t("admin.policy.untitled"))}` : ""}${rule ? ` / ${e(rule.label || rule.id)}` : ""}</span></nav>
      <h1 id="policy-view-title" tabindex="-1">${e(title)}</h1>
      ${this.error ? `<p role="alert" class="error">${e(this.error)}</p>` : ""}
      <p role="status" id="policy-message">${e(this.message)}</p>
      ${
        d
          ? `
        ${editing ? `<p>${text("editHelp")}</p><div class="policy-toolbar">${button("policy-save", "saveEdit", this.busy)}${button("policy-cancel", "cancel", this.busy)}<span id="policy-save-state" role="status">${text(this.dirty ? "unsaved" : this.revision === 0 ? "starter" : "savedState")}</span></div>` : view.kind === "categories" ? `<p>${text("tableIntro")}</p><wa-callout>${text("activationGate")}</wa-callout><div class="policy-toolbar">${button("policy-save", "save", this.busy)}${button("policy-reload", "reload", this.busy)}${button("policy-validate", "validate", this.busy)}${button("policy-export", "export", this.busy)}<span id="policy-save-state" role="status">${text(this.dirty ? "unsaved" : this.revision === 0 ? "starter" : "savedState")}</span></div><p>${text("version", { version: this.activeVersion, revision: this.revision })}</p>` : ""}
        ${editing ? `<fieldset ${this.busy ? "disabled" : ""}><legend>${text("edit")}</legend>${view.kind === "category" ? this.categoryView() : this.rulesView()}</fieldset>` : view.kind === "categories" ? this.categoriesTable() : this.rulesTable()}
        ${view.kind === "rules" ? this.scenarioView() : ""}
        ${this.reportView()}
        ${view.kind === "categories" ? this.releaseView() : ""}
      `
          : `<p role="status">${text(this.busy ? "loading" : "requestFailed")}</p>${button("policy-reload", "reload", this.busy)}`
      }
    </section>`;
    this.enhanceFieldHelp();
  }
  categoriesTable() {
    return `<wa-input id="policy-search" label="${text("search")}" value="${e(this.search)}"></wa-input><div class="policy-table-wrap"><table id="policy-categories-table"><caption class="policy-sr-only">${text("title")}</caption><thead><tr><th scope="col">${text("category")}</th><th scope="col">${text("edit")}</th><th scope="col">${text("rules")}</th></tr></thead><tbody>${this.document.categories
      .filter((c) => c.name.toLowerCase().includes(this.search.toLowerCase()))
      .map(
        (c) =>
          `<tr><th scope="row">${e(c.name) || text("untitled")}</th><td><button class="btn-secondary" type="button" data-edit-category="${e(c.id)}" aria-label="${text("editNamedCategory", { category: c.name || t("admin.policy.untitled") })}">${text("edit")}</button></td><td><button class="btn-secondary" type="button" data-category-rules="${e(c.id)}" aria-label="${text("viewRulesFor", { category: c.name || t("admin.policy.untitled") })}">${text("viewRules")} (${this.document.rules.filter((r) => r.categoryId === c.id).length})</button></td></tr>`,
      )
      .join(
        "",
      )}</tbody></table></div>${button("policy-add-category", "addCategory", this.busy)}`;
  }
  rulesTable() {
    const rules = this.document.rules.filter(
      (r) => r.categoryId === this.categoryId,
    );
    return `<p>${text("rulesIntro")}</p><div class="policy-table-wrap"><table id="policy-rules-table"><caption class="policy-sr-only">${text("rules")}</caption><thead><tr><th scope="col">${text("label")}</th><th scope="col">${text("severity")}</th><th scope="col">${text("actionType")}</th><th scope="col">${text("edit")}</th></tr></thead><tbody>${rules.map((r) => `<tr><th scope="row">${e(r.label || r.id)}</th><td>${r.severityMin}–${r.severityMax}</td><td>${text(`action.${r.actionType}`)}</td><td><button class="btn-secondary" type="button" data-edit-rule="${e(r.id)}" aria-label="${text("editNamedRule", { rule: r.label || r.id })}">${text("edit")}</button></td></tr>`).join("")}</tbody></table></div>${!rules.length ? `<p>${text("noRules")}</p>` : ""}${button("policy-add-rule", "createRule", this.busy)}`;
  }
  releaseView() {
    return `      <section class="subsection"><h2>${text("release")}</h2><p>${text("releaseHelp")}</p>
      <wa-checkbox id="policy-translations-check" ${this.includeTranslations ? "checked" : ""}>${text("checkTranslations")}</wa-checkbox>
      <wa-textarea id="policy-reason" label="${text("reason")}" value="${e(this.reason)}" maxlength="1000"></wa-textarea>
      ${button("policy-release", "prepare", this.busy || this.dirty || !this.report?.valid || !this.includeTranslations)}
      <ul>${this.releases.map((r) => `<li>${e(formatDateTime(r.createdAt, { dateStyle: "medium", timeStyle: "short" }))}: ${e(r.reason)} — ${text("preparedStatus")} <button class="btn-secondary" type="button" data-download="${e(r.releaseId)}">${text("download")}</button></li>`).join("")}</ul>${this.historyTruncated ? `<p>${text("historyTruncated")}</p>` : ""}</section>
      <details class="subsection"><summary>${text("import")}</summary><p>${text("importHelp")}</p>
      <label>${text("jsonFile")}<input type="file" id="policy-json-file" accept="application/json,.json"></label>
      <label>${text("categoriesFile")}<input type="file" id="policy-categories-file" accept="text/csv,.csv"></label>
      <label>${text("rulesFile")}<input type="file" id="policy-rules-file" accept="text/csv,.csv"></label>${button("policy-import", "importPreview", this.busy)}</details>`;
  }
  categoryView() {
    const i = this.document.categories.findIndex(
        (c) => c.id === this.categoryId,
      ),
      c = this.document.categories[i];
    if (!c) return "";
    const p = `categories/${i}`;
    return `<h2 id="policy-category-title" tabindex="-1">${text("recognition")}</h2>
      ${input(`${p}/name`, "name", c.name)}${select(
        `${p}/weighting`,
        "weighting",
        c.weighting,
        ["Low", "Moderate", "High"].map((v) => [
          v,
          t(`admin.policy.weight.${v}`),
        ]),
      )}
      ${["definition", "includes", "excludes", "visualCues", "descriptionGuidance"].map((field) => area(`${p}/${field}`, field, c[field])).join("")}
      <h3>${text("severityGuidance")}</h3><p>${text("zeroHelp")}</p>${c.severityGuidance.map((value, n) => area(`${p}/severityGuidance/${n}`, `level${n}`, value)).join("")}
      ${area(`${p}/aliases`, "aliases", c.aliases.join("\n"))}
      <details><summary>${text("retireCategory")}</summary><p>${text("retireHelp")}</p>${button("policy-remove-category", "removeCategory", this.busy)}</details><details><summary>${text("translations")}</summary>${this.translationsView()}</details>`;
  }
  rulesView() {
    const d = this.document;
    if (!this.categoryId) return "";
    const rules = d.rules.filter((r) => r.categoryId === this.categoryId);
    const i = d.rules.findIndex((r) => r.id === this.ruleId),
      r = d.rules[i];
    const p = `rules/${i}`;
    return `      ${
      r
        ? `<p class="policy-reference">${text("reference", { id: r.id })}</p><div class="policy-form-grid">
      ${input(`${p}/severityMin`, "severityMin", r.severityMin, "number")}${input(`${p}/severityMax`, "severityMax", r.severityMax, "number")}
      ${check(`${p}/schedule/always`, "allHours", r.schedule.always)}
      ${r.schedule.always ? "" : `${input(`${p}/schedule/start`, "start", clock(r.schedule.start), "time")}${input(`${p}/schedule/end`, "end", clock(r.schedule.end), "time")}<fieldset><legend>${text("days")}</legend>${[0, 1, 2, 3, 4, 5, 6].map((day) => `<wa-checkbox data-day="${day + 1}" ${r.schedule.days.includes(day) ? "checked" : ""}>${text(`day${day}`)}</wa-checkbox>`).join("")}</fieldset><p>${text("timeHelp")}</p>`}
      ${select(`${p}/questionId`, "question", r.questionId, [["", t("admin.policy.noQuestion")], ...d.questions.map((q) => [q.id, q.prompt || t("admin.policy.untitledQuestion")])])}${button("policy-add-question", "newQuestion", this.busy)}
      ${
        r.questionId
          ? `${area(`questions/${d.questions.findIndex((q) => q.id === r.questionId)}/prompt`, "prompt", d.questions.find((q) => q.id === r.questionId)?.prompt ?? "")}${select(
              `${p}/answer`,
              "answer",
              String(r.answer),
              [
                ["true", t("common.yes")],
                ["false", t("common.no")],
              ],
            )}<p>${text("answerHelp")}</p>`
          : ""
      }
      ${select(
        `${p}/actionType`,
        "actionType",
        r.actionType,
        ["site", "phone", "ticket"].map((v) => [
          v,
          t(`admin.policy.action.${v}`),
        ]),
      )}
      ${area(`${p}/label`, "label", r.label)}${area(`${p}/button`, "button", r.button)}${area(`${p}/guidance`, "guidance", r.guidance)}
      ${r.actionType === "phone" ? input(`${p}/phone`, "phone", r.phone, "tel") : ""}
      <wa-select id="policy-routing-preset" label="${text("routingPreset")}" value=""><wa-option value="">${text("choosePreset")}</wa-option>${[
        ...new Set([
          ...(this.referenceRules ?? []).map((rule) => rule.routing),
          "Run bulky item analysis",
          "Run graffiti analysis",
        ]),
      ]
        .filter(Boolean)
        .map(
          (route) => `<wa-option value="${e(route)}">${e(route)}</wa-option>`,
        )
        .join(
          "",
        )}</wa-select>${input(`${p}/routing`, "routing", r.routing)}<p>${text("routingHelp")}</p>
      <wa-select id="policy-agency-preset" label="${text("agencyPreset")}" value=""><wa-option value="">${text("choosePreset")}</wa-option>${[
        ...new Set(
          (this.referenceRules ?? []).map((rule) =>
            JSON.stringify([rule.agency, rule.phone, rule.agencyCode]),
          ),
        ),
      ]
        .map((value) => {
          const [agency, phone] = JSON.parse(value);
          return `<wa-option value="${e(value)}">${e(agency)} ${e(phone)}</wa-option>`;
        })
        .join(
          "",
        )}</wa-select>${input(`${p}/agency`, "agency", r.agency)}${input(`${p}/agencyCode`, "agencyCode", r.agencyCode)}
      ${check(`${p}/inProgress`, "inProgress", r.inProgress)}${input(`${p}/responseHours`, "deadline", r.responseHours, "number")}
      <details><summary>${text("precedence")}</summary><p>${text("precedenceHelp")}</p>${input(`${p}/order`, "order", r.order, "number")}${area(`${p}/overrides`, "overrides", r.overrides.join("\n"))}</details>
      </div><section class="policy-task-preview"><h3>${text("taskPreview")}</h3><p data-task-preview="label">${e(r.label)}</p><p data-task-preview="guidance">${e(r.guidance)}</p><span class="policy-button-preview" data-task-preview="button">${e(r.button)}</span><p><span data-task-preview="agency">${e(r.agency)}</span> <span data-task-preview="phone">${e(r.phone)}</span></p></section>
      ${button("policy-remove-rule", "retireRule", this.busy)}`
        : ""
    }
      <details><summary>${text("translations")}</summary>${this.translationsView()}</details>`;
  }
  translationsView() {
    return policyTranslationFields(
      this.document,
      this.ruleId ? "" : this.categoryId,
      this.ruleId,
    )
      .map(
        ([key, source]) =>
          `<fieldset><legend>${e(source || key)}</legend>${["es", "fil", "vi", "zh-Hant"].map((locale) => `<wa-textarea label="${text(`locale.${locale}`)}" data-translation="${e(key)}" data-locale="${locale}" value="${e(this.document.translations[locale]?.[key] ?? "")}"></wa-textarea>`).join("")}</fieldset>`,
      )
      .join("");
  }
  scenarioView() {
    const questions = this.document.questions.filter((q) =>
      this.document.rules.some(
        (r) => r.categoryId === this.categoryId && r.questionId === q.id,
      ),
    );
    return `<section class="subsection"><h2>${text("scenario")}</h2><p>${text("scenarioHelp")}</p>
      <div class="policy-form-grid"><wa-input id="scenario-severity" type="number" min="0" max="5" label="${text("severity")}" value="${this.scenario.severity}"></wa-input><wa-input id="scenario-time" label="${text("reportedAt")}" value="${e(this.scenario.reportedAt)}"></wa-input>
      ${questions.map((q) => `<wa-select label="${e(q.prompt)}" data-question="${e(q.id)}" value="${Object.hasOwn(this.scenario.answers, q.id) ? String(this.scenario.answers[q.id]) : "unanswered"}"><wa-option value="unanswered">${text("unanswered")}</wa-option><wa-option value="true">${e(t("common.yes"))}</wa-option><wa-option value="false">${e(t("common.no"))}</wa-option></wa-select>`).join("")}</div>
      ${button("policy-preview", "test", this.busy || !this.categoryId)}
      ${this.preview ? `<div id="policy-scenario-result" role="status" class="policy-task-preview"><h3>${text(`result.${this.preview.kind.replaceAll("_", "-")}`)}</h3>${this.preview.kind === "needs_answer" ? `<p>${e(this.preview.question.prompt)}</p>` : this.preview.kind === "outcome" ? `<p>${e(this.preview.rule.ruleId)}: ${e(this.preview.outcome.label)}</p><p>${e(this.preview.outcome.guidance)}</p>` : ""}${this.previousPreview ? `<h3>${text("previousOutcome")}</h3><p>${e(this.previousPreview.outcome?.label ?? this.previousPreview.question?.prompt ?? t("admin.policy.noOutcome"))}</p>` : ""}</div>` : ""}</section>`;
  }
  reviewView() {
    if (!this.report.diff) return "";
    const diff = this.report.diff;
    const value = (v) =>
      e(
        v === null || v === undefined
          ? "—"
          : typeof v === "object"
            ? JSON.stringify(v, null, 2)
            : String(v),
      );
    const rows = [
      ...(this.report.categoryChanges ?? []).map((c) => ({
        name: c.category,
        field: t(`admin.policy.${c.field}`),
        before: c.before,
        after: c.after,
      })),
      ...diff.changedRules.flatMap((r) =>
        r.changes.map((c) => ({
          name: r.ruleId,
          field: t(`admin.policy.change.${c.path}`),
          before: c.before,
          after: c.after,
        })),
      ),
    ];
    return `<details><summary>${text("reviewChanges")}</summary><p>${text("diff", { added: diff.addedRules.length, removed: diff.removedRules.length, changed: diff.changedRules.length })}</p>
      <p>${text("addedRules")}: ${e(diff.addedRules.join(", ") || "—")}</p><p>${text("removedRules")}: ${e(diff.removedRules.join(", ") || "—")}</p>
      <p>${text("removedCategories")}: ${e((this.report.removedCategories ?? []).join(", ") || "—")}</p>
      <table><thead><tr><th>${text("field")}</th><th>${text("before")}</th><th>${text("after")}</th></tr></thead><tbody>${rows.map((row) => `<tr><th>${e(row.name)}: ${e(row.field)}</th><td>${value(row.before)}</td><td>${value(row.after)}</td></tr>`).join("")}</tbody></table></details>`;
  }
  coverageView() {
    const category = this.document.categories.find(
      (c) => c.id === this.categoryId,
    );
    const scenarios = (this.report.coverage ?? []).filter(
      (s) => s.category === category?.name,
    );
    return `<details><summary>${text("coverage")}</summary><p>${text("coverageHelp")}</p>${this.report.coverageTruncated ? `<p>${text("coverageTruncated")}</p>` : ""}
    <table><thead><tr><th>${text("scenario")}</th><th>${text("rule")}</th></tr></thead><tbody>${scenarios
      .map(
        (s) =>
          `<tr><td>${text("example", {
            severity: s.severity,
            day: t(`admin.policy.day${s.day}`),
            time: clock(s.minute),
            answers: Object.entries(s.answers)
              .map(
                ([key, value]) =>
                  `${this.document.questions.find((q) => q.id === key)?.prompt ?? key}: ${t(value ? "common.yes" : "common.no")}`,
              )
              .join(", "),
          })}</td><td>${s.ruleId ? e(s.ruleId) : text("noOutcome")}</td></tr>`,
      )
      .join("")}</tbody></table></details>`;
  }
  reportView() {
    if (!this.report) return "";
    return `<section id="policy-validation" class="subsection" aria-live="polite"><h2>${text(this.report.valid ? "valid" : "problems")}</h2>
      <ul>${this.report.issues
        .map((issue) => {
          const rule = this.document.rules.find(
            (r) =>
              `rules.${r.id}` === issue.path ||
              issue.path.startsWith(`rules.${r.id}.`),
          );
          const category = this.document.categories.find(
            (c) =>
              issue.path.startsWith(`categories.${c.id}`) ||
              c.id === rule?.categoryId,
          );
          return `<li>${text(`issue.${issue.code}`)} — ${e(rule?.label || category?.name || issue.path)} ${issue.relatedRuleIds ? e(issue.relatedRuleIds.join(", ")) : ""}${
            issue.scenario
              ? `<p>${text("example", {
                  severity: issue.scenario.severity,
                  day: t(`admin.policy.day${issue.scenario.day}`),
                  time: clock(issue.scenario.minute),
                  answers: Object.entries(issue.scenario.answers)
                    .map(
                      ([key, value]) =>
                        `${this.document.questions.find((q) => q.id === key)?.prompt ?? key}: ${t(value ? "common.yes" : "common.no")}`,
                    )
                    .join(", "),
                })}</p>`
              : ""
          }${category ? `<button type="button" class="btn-secondary" data-issue-category="${e(category.id)}" data-issue-rule="${e(rule?.id ?? "")}">${text("edit")}</button>` : ""}</li>`;
        })
        .join("")}</ul>
      ${
        Object.keys(this.report.witnesses).length
          ? `<details><summary>${text("workingExamples")}</summary><table><thead><tr><th>${text("rule")}</th><th>${text("scenario")}</th></tr></thead><tbody>${Object.entries(
              this.report.witnesses,
            )
              .map(
                ([id, s]) =>
                  `<tr><td>${e(id)}</td><td>${text("example", {
                    severity: s.severity,
                    day: t(`admin.policy.day${s.day}`),
                    time: clock(s.minute),
                    answers: Object.entries(s.answers)
                      .map(
                        ([key, value]) =>
                          `${this.document.questions.find((q) => q.id === key)?.prompt ?? key}: ${t(value ? "common.yes" : "common.no")}`,
                      )
                      .join(", "),
                  })}</td></tr>`,
              )
              .join("")}</tbody></table></details>`
          : ""
      }
      ${this.reviewView()}${this.coverageView()}</section>`;
  }
}

function download(name, contents) {
  const url = URL.createObjectURL(
    new Blob([contents], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
customElements.define("policy-editor", PolicyEditor);
