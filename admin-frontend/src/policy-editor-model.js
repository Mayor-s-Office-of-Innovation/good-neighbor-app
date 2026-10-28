/** Read/write only explicit editor paths, never object prototypes or arbitrary server keys. */
export function setPolicyField(document, path, value) {
  const parts = path.split("/");
  if (
    parts.some((part) =>
      ["__proto__", "prototype", "constructor"].includes(part),
    )
  )
    return;
  let target = document;
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(target, part)) return;
    target = target[part];
  }
  target[parts.at(-1)] = value;
}

export function newCategory() {
  return {
    id: `c_${crypto.randomUUID()}`,
    name: "",
    weighting: "Low",
    definition: "",
    includes: "",
    excludes: "",
    visualCues: "",
    descriptionGuidance: "",
    severityGuidance: Array(6).fill(""),
    aliases: [],
  };
}

export function newRule(categoryId) {
  return {
    id: `r_${crypto.randomUUID()}`,
    categoryId,
    severityMin: 1,
    severityMax: 5,
    order: 1,
    schedule: {
      always: true,
      start: 0,
      end: 1439,
      days: [0, 1, 2, 3, 4, 5, 6],
    },
    questionId: "",
    answer: true,
    actionType: "site",
    label: "",
    button: "",
    guidance: "",
    phone: "",
    routing: "",
    agencyCode: "",
    agency: "",
    inProgress: false,
    responseHours: null,
    overrides: [],
  };
}

export function policyTranslationFields(document, categoryId, ruleId) {
  const fields = [];
  const category = document.categories.find((c) => c.id === categoryId);
  if (category) fields.push([`category.${category.id}.name`, category.name]);
  const rule = document.rules.find((r) => r.id === ruleId);
  if (rule) {
    for (const field of ["label", "button", "guidance", "agency"])
      fields.push([`rule.${rule.id}.${field}`, rule[field]]);
    const question = document.questions.find((q) => q.id === rule.questionId);
    if (question)
      fields.push([`question.${question.id}.prompt`, question.prompt]);
  }
  return fields;
}

export function invalidatePolicyTranslations(document, key) {
  for (const values of Object.values(document.translations)) delete values[key];
}

/** A form owns a reversible snapshot, including shared questions and translations. */
export class PolicyEditStack {
  views = [{ kind: "categories", categoryId: "", ruleId: "" }];
  snapshot = null;
  priorDirty = false;
  get current() {
    return this.views.at(-1);
  }
  get editing() {
    return this.snapshot !== null;
  }
  push(view) {
    this.views.push(view);
  }
  begin(document, dirty, view) {
    this.snapshot = structuredClone(document);
    this.priorDirty = dirty;
    this.push(view);
  }
  changed(document) {
    return (
      this.editing && JSON.stringify(document) !== JSON.stringify(this.snapshot)
    );
  }
  cancel() {
    const result = { document: this.snapshot, dirty: this.priorDirty };
    this.snapshot = null;
    this.views.pop();
    return result;
  }
  saved() {
    this.snapshot = null;
    this.views.pop();
  }
  back() {
    if (this.views.length > 1) this.views.pop();
  }
}
