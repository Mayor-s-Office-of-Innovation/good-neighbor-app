// @vitest-environment node
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { adminSession, createAdminSession } from "./admin-session.js";
import { adminApi } from "./services/admin-api.js";

/**
 * @param {string} role
 * @param {() => Promise<any>} [readProfile]
 */
function fakeSession(
  role,
  readProfile = async () => ({ profile: { firstName: "Casey" } }),
) {
  vi.spyOn(adminApi, "getSession").mockImplementation(async () => ({
    role,
    capabilities: { createEntities: role === "compliance-supervisor" },
  }));
  return vi.spyOn(adminApi, "getMyProfile").mockImplementation(readProfile);
}

afterEach(() => {
  adminSession.clear();
});

test("a supervisor's session sets the role and capabilities without a profile read", async () => {
  const profile = fakeSession("compliance-supervisor");
  await adminSession.load();
  assert.equal(adminSession.role, "compliance-supervisor");
  assert.deepEqual(adminSession.capabilities, { createEntities: true });
  assert.equal(adminSession.profile, null);
  assert.equal(profile.mock.calls.length, 0);
});

test("a compliance manager's session also reads their profile", async () => {
  fakeSession("compliance-manager");
  await adminSession.load();
  assert.deepEqual(adminSession.profile, { firstName: "Casey" });
});

test("a failed profile read still leaves the role known", async () => {
  fakeSession("compliance-manager", async () => {
    throw new Error("profile_down");
  });
  await assert.rejects(adminSession.load(), /profile_down/);
  assert.equal(adminSession.role, "compliance-manager");
});

test("a session reply without a role or capabilities leaves both empty", async () => {
  vi.spyOn(adminApi, "getSession").mockImplementation(async () => ({}));
  await adminSession.load();
  assert.equal(adminSession.role, "");
  assert.deepEqual(adminSession.capabilities, {});
});

test("clear() forgets the role, capabilities and profile", () => {
  adminSession.seed({
    role: "compliance-manager",
    capabilities: { createEntities: false },
    profile: { firstName: "Casey" },
  });
  adminSession.clear();
  assert.equal(adminSession.role, "");
  assert.deepEqual(adminSession.capabilities, {});
  assert.equal(adminSession.profile, null);
});

test("a session read still running at clear() doesn't sign the next user in", async () => {
  /** @type {(value: any) => void} */
  let release = () => {};
  vi.spyOn(adminApi, "getSession").mockImplementation(
    () => new Promise((resolve) => (release = resolve)),
  );
  const load = adminSession.load();
  adminSession.clear();
  release({
    role: "compliance-supervisor",
    capabilities: { createEntities: true },
  });
  await load;
  assert.equal(adminSession.role, "");
  assert.deepEqual(adminSession.capabilities, {});
});

test("a profile read still running at clear() doesn't reach the next user", async () => {
  /** @type {(value: any) => void} */
  let release = () => {};
  const profile = fakeSession(
    "compliance-manager",
    () => new Promise((resolve) => (release = resolve)),
  );
  const load = adminSession.load();
  while (profile.mock.calls.length === 0)
    await new Promise((resolve) => setImmediate(resolve));
  adminSession.clear();
  release({ profile: { firstName: "Casey" } });
  await load;
  assert.equal(adminSession.profile, null);
});

test("a session read still running at seed() keeps the seeded session", async () => {
  /** @type {(value: any) => void} */
  let release = () => {};
  vi.spyOn(adminApi, "getSession").mockImplementation(
    () => new Promise((resolve) => (release = resolve)),
  );
  const load = adminSession.load();
  adminSession.seed({ role: "compliance-manager", capabilities: {} });
  release({
    role: "compliance-supervisor",
    capabilities: { createEntities: true },
  });
  await load;
  assert.equal(adminSession.role, "compliance-manager");
  assert.deepEqual(adminSession.capabilities, {});
});

test("each created session keeps its own role", () => {
  const supervisor = createAdminSession();
  supervisor.seed({ role: "compliance-supervisor" });
  const manager = createAdminSession();
  manager.seed({ role: "compliance-manager" });
  assert.equal(supervisor.role, "compliance-supervisor");
  assert.equal(adminSession.role, "");
});

test("a session that changes to a supervisor drops the manager's profile", async () => {
  fakeSession("compliance-manager");
  await adminSession.load();
  fakeSession("compliance-supervisor");
  await adminSession.load();
  assert.equal(adminSession.profile, null);
});
