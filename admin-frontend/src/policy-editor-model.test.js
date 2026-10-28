import test from "node:test";
import assert from "node:assert/strict";
import {
  PolicyEditStack,
  newCategory,
  newRule,
  setPolicyField,
  policyTranslationFields,
  invalidatePolicyTranslations,
} from "./policy-editor-model.js";

test("stack cancellation restores shared data and the previous draft state", () => {
  const d = {
    categories: [newCategory()],
    rules: [],
    questions: [{ id: "q", prompt: "Original" }],
    translations: { es: { key: "Original translation" } },
  };
  const stack = new PolicyEditStack();
  stack.push({ kind: "rules", categoryId: d.categories[0].id, ruleId: "" });
  stack.begin(d, true, {
    kind: "rule",
    categoryId: d.categories[0].id,
    ruleId: "example",
  });
  d.questions[0].prompt = "Changed";
  d.translations.es = {};
  assert.equal(stack.changed(d), true);
  const result = stack.cancel();
  assert.equal(result.document.questions[0].prompt, "Original");
  assert.equal(result.document.translations.es.key, "Original translation");
  assert.equal(result.dirty, true);
  assert.equal(stack.current.kind, "rules");
});
test("successful save pops only the editor and clears its cancellation snapshot", () => {
  const stack = new PolicyEditStack();
  stack.begin({ categories: [] }, false, {
    kind: "category",
    categoryId: "new",
    ruleId: "",
  });
  stack.saved();
  assert.equal(stack.editing, false);
  assert.equal(stack.current.kind, "categories");
});

test("editor references survive renaming and are generated independently", () => {
  const c = newCategory(),
    r = newRule(c.id);
  const d = { categories: [c], rules: [r] };
  setPolicyField(d, "categories/0/name", "New synthetic name");
  assert.equal(r.categoryId, c.id);
  assert.equal(c.name, "New synthetic name");
  assert.notEqual(c.id, newCategory().id);
});
test("editor paths cannot mutate object prototypes", () => {
  const d = { categories: [] };
  setPolicyField(d, "__proto__/policyInjected", true);
  assert.equal({}.policyInjected, undefined);
});
test("translation fields use stable IDs and clear changed source text in every language", () => {
  const c = newCategory(),
    r = newRule(c.id),
    d = {
      categories: [c],
      rules: [r],
      questions: [],
      translations: { es: { [`rule.${r.id}.label`]: "Synthetic translation" } },
    };
  assert.equal(policyTranslationFields(d, c.id, r.id).length, 5);
  invalidatePolicyTranslations(d, `rule.${r.id}.label`);
  assert.deepEqual(d.translations.es, {});
});
