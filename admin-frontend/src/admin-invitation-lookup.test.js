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
  const add = { setAttribute() {} };
  controls.departmentId.querySelectorAll = () => [];
  controls.departmentId.append = () => {};
  const form = {
    isConnected: true,
    querySelector(selector) {
      if (selector.includes('name="'))
        return controls[selector.match(/name="([^"]+)"/)[1]];
      return selector.includes("lookup-status")
        ? status
        : selector.includes("phone-extension")
          ? extension
          : add;
    },
    dispatchEvent() {},
  };
  return {
    controls,
    status,
    form,
    extension,
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
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
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
