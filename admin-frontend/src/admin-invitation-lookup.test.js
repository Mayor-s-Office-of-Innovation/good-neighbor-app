import test from "node:test";
import assert from "node:assert/strict";
import { bindAdminInvitationLookup } from "./admin-invitation-lookup.js";

function fixture(lookup) {
  const controls = Object.fromEntries(
    [
      "email",
      "firstName",
      "lastName",
      "phone",
      "phoneExtension",
      "departmentId",
    ].map((key) => [
      key,
      {
        value: "",
        addEventListener(name, callback) {
          this[name] = callback;
        },
      },
    ]),
  );
  const status = {};
  const extension = {};
  const add = {
    setAttribute() {},
    addEventListener(type, callback) {
      this[type] = callback;
    },
  };
  const remove = {
    addEventListener(type, callback) {
      this[type] = callback;
    },
  };
  const options = [];
  controls.departmentId.querySelectorAll = () => options;
  controls.departmentId.append = (option) => options.push(option);

  const form = {
    isConnected: true,
    querySelector(selector) {
      if (selector.includes('name="'))
        return controls[selector.match(/name="([^"]+)"/)[1]];
      return selector.includes("lookup-status")
        ? status
        : selector.includes("phone-extension")
          ? extension
          : selector.includes("remove-extension")
            ? remove
            : add;
    },
    dispatchEvent() {},
  };
  return {
    controls,
    status,
    form,
    extension,
    add,
    remove,
    options,
    ensure: bindAdminInvitationLookup(form, lookup, (key) => key),
  };
}
const saved = {
  firstName: "Alex",
  lastName: "Example",
  phone: "415-555-0100",
  phoneExtension: "12",
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};

test("email lookup prefills a contact without an account; repeated submit shares the lookup", async () => {
  let calls = 0;
  const f = fixture(async (email) => {
    calls++;
    assert.equal(email, "alex@example.org");
    return { profile: saved };
  });
  f.controls.email.value = " Alex@Example.org ";
  await Promise.all([f.ensure(), f.ensure()]);
  assert.equal(calls, 1);
  assert.equal(f.controls.firstName.value, saved.firstName);
  assert.equal(f.controls.phone.value, saved.phone);
  assert.equal(f.controls.phoneExtension.value, "12");
  assert.equal(f.extension.hidden, false);
  assert.equal(f.status.textContent, "admin.users.lookupFound");
});

test("a changed email clears prefilled details and ignores a late response", async () => {
  const first = deferred();
  const f = fixture((email) =>
    email === "first@example.org"
      ? first.promise
      : Promise.resolve({ profile: null }),
  );
  f.controls.email.value = "first@example.org";
  const pending = f.ensure();
  await Promise.resolve();
  f.controls.email.value = "second@example.org";
  await f.ensure();
  first.resolve({ profile: saved });
  await pending;
  assert.equal(f.controls.firstName.value, "");
  assert.equal(f.status.textContent, "admin.users.lookupNew");
});

test("changing email after a match clears unchanged values, keeping manual edits", async () => {
  const f = fixture(async (email) => ({
    profile: email === "first@example.org" ? saved : null,
  }));
  f.controls.email.value = "first@example.org";
  await f.ensure();
  f.controls.lastName.value = "Edited";
  f.controls.email.value = "second@example.org";
  await f.ensure();
  assert.equal(f.controls.firstName.value, "");
  assert.equal(f.controls.phone.value, "");
  assert.equal(f.controls.phoneExtension.value, "");
  assert.equal(f.extension.hidden, true);
  assert.equal(f.controls.lastName.value, "Edited");
});

test("lookup errors block submission and can be retried without losing the draft", async () => {
  let fail = true;
  const f = fixture(async () => {
    if (fail) throw new Error("offline");
    return { profile: null };
  });
  f.controls.email.value = "new@example.org";
  f.controls.firstName.value = "Draft";
  await assert.rejects(f.ensure(), /offline/);
  assert.equal(f.status.textContent, "admin.users.lookupFailed");
  assert.equal(f.controls.firstName.value, "Draft");
  fail = false;
  await f.ensure();
  assert.equal(f.status.textContent, "admin.users.lookupNew");
});

test("invalid email never queries the directory", async () => {
  const f = fixture(() => {
    throw new Error("unexpected query");
  });
  f.controls.email.value = "incomplete";
  await f.ensure();
});

test("submission follows the current email after an abandoned lookup fails", async () => {
  const old = deferred();
  const f = fixture((email) =>
    email === "first@example.org"
      ? old.promise
      : Promise.resolve({ profile: saved }),
  );
  f.controls.email.value = "first@example.org";
  const submitting = f.ensure();
  await Promise.resolve();
  f.controls.email.value = "second@example.org";
  await f.ensure();
  old.reject(new Error("obsolete failure"));
  await submitting;
  assert.equal(f.controls.firstName.value, saved.firstName);
  assert.equal(f.status.textContent, "admin.users.lookupFound");
});

test("a stale failure waits for a replacement lookup even when email changes back", async () => {
  const old = deferred(),
    current = deferred();
  let calls = 0;
  const f = fixture(() => (++calls === 1 ? old.promise : current.promise));
  f.controls.email.value = "first@example.org";
  let submitted = false;
  const submitting = f.ensure().then(() => {
    submitted = true;
  });
  await Promise.resolve();
  f.controls.email.value = "second@example.org";
  f.controls.email.input();
  f.controls.email.value = "first@example.org";
  const replacement = f.ensure();
  old.reject(new Error("obsolete failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submitted, false);
  current.resolve({ profile: saved });
  await Promise.all([submitting, replacement]);
  assert.equal(calls, 2);
});

test("historical department options and their selections are cleared for a new email", async (t) => {
  const original = globalThis.document;
  let f;
  globalThis.document = {
    createElement() {
      return {
        remove() {
          f.options.splice(f.options.indexOf(this), 1);
        },
      };
    },
  };
  t.after(() => {
    if (original) globalThis.document = original;
    else delete globalThis.document;
  });
  f = fixture(async (email) => ({
    profile:
      email === "first@example.org"
        ? {
            ...saved,
            departmentId: "historical",
            departmentName: "Synthetic historical department",
          }
        : null,
  }));
  const active = { value: "active" };
  f.options.push(active);
  f.controls.email.value = "first@example.org";
  await f.ensure();
  assert.equal(f.options.length, 2);
  assert.equal(f.controls.departmentId.value, "historical");
  f.controls.email.value = "second@example.org";
  await f.ensure();
  assert.deepEqual(f.options, [active]);
  assert.equal(f.controls.departmentId.value, "");
});

test("changing email preserves a manually selected active department", async (t) => {
  const original = globalThis.document;
  globalThis.document = {
    createElement() {
      return { remove() {} };
    },
  };
  t.after(() => {
    if (original) globalThis.document = original;
    else delete globalThis.document;
  });
  const f = fixture(async () => ({
    profile: { ...saved, departmentId: "historical" },
  }));
  f.controls.email.value = "first@example.org";
  await f.ensure();
  f.controls.departmentId.value = "active";
  f.controls.email.value = "";
  f.controls.email.input();
  // Cancel the debounce without scheduling a directory query.
  await f.ensure();
  assert.equal(f.controls.departmentId.value, "active");
});

test("lookup updates preserve manual extension disclosure until explicit removal", async () => {
  const f = fixture(async () => ({ profile: null }));
  f.add.click();
  f.controls.email.value = "new@example.org";
  await f.ensure();
  assert.equal(f.extension.hidden, false);
  f.controls.email.value = "";
  f.controls.email.input();
  await f.ensure();
  assert.equal(f.extension.hidden, false);
  f.remove.click();
  f.controls.email.value = "other@example.org";
  await f.ensure();
  assert.equal(f.extension.hidden, true);
});

test("an abandoned failure resolves the new address and still propagates its current failure", async () => {
  const old = deferred();
  const queried = [];
  const f = fixture((email) => {
    queried.push(email);
    if (email === "first@example.org") return old.promise;
    throw new Error("current lookup unavailable");
  });
  f.controls.email.value = "first@example.org";
  const submitting = f.ensure();
  await Promise.resolve();
  f.controls.email.value = "second@example.org";
  old.reject(new Error("obsolete failure"));
  await assert.rejects(submitting, /current lookup unavailable/);
  assert.deepEqual(queried, ["first@example.org", "second@example.org"]);
  assert.equal(f.status.textContent, "admin.users.lookupFailed");
});
