import { adminData } from "./admin-mock.js";

/** Provider v1 with managers, grants and enrolled devices, plus a Program it can adopt. */
export function providerData() {
  const data = /** @type {any} */ (adminData());
  data.programs.push({
    programId: "p3",
    name: "Another Program",
    providerId: "v2",
    status: "active",
  });
  data.people.forEach((/** @type {any} */ person) =>
    Object.assign(person, {
      name: `${person.firstName} ${person.lastName}`,
    }),
  );
  data.providerManagers = [
    {
      membershipId: "m1",
      personId: "u1",
      name: "Alex Example",
      firstName: "Alex",
      lastName: "Example",
      email: "alex@example.org",
      phone: "4155550101",
      status: "active",
      activeDeviceCount: 1,
    },
    {
      membershipId: "m2",
      personId: "u3",
      name: "Former Manager",
      firstName: "Former",
      lastName: "Manager",
      email: "former@example.org",
      status: "inactive",
    },
  ];
  data.providerEnrollments = [
    {
      enrollmentId: "e1",
      membershipId: "m1",
      physicalDeviceId: "device-0000000001",
      activeSiteCount: 1,
      siteCount: 2,
      createdAt: "2026-10-20T10:00:00Z",
      status: "active",
    },
    {
      enrollmentId: "e2",
      membershipId: "gone",
      physicalDeviceId: "device-0000000002",
      createdAt: "2026-10-21T10:00:00Z",
      status: "active",
    },
    { enrollmentId: "e3", membershipId: "m1", status: "revoked" },
  ];
  data.providerGrants = [
    {
      grantId: "g1",
      issuedTo: "alex@example.org",
      enrollmentUrl: "https://example.org/enroll/g1",
      deliveryMode: "link",
      siteCount: 1,
      createdAt: "2026-10-20T10:00:00Z",
      expiresAt: "2026-10-27T10:00:00Z",
      status: "pending",
      deliveryStatus: "accepted",
    },
    {
      grantId: "g2",
      issuedTo: "alex@example.org",
      deliveryMode: "code",
      createdAt: "2026-10-19T10:00:00Z",
      expiresAt: "2026-10-26T10:00:00Z",
      status: "used",
    },
  ];
  for (const list of [
    data.providerManagers,
    data.providerEnrollments,
    data.providerGrants,
  ])
    list.forEach((/** @type {any} */ item) => (item.providerId = "v1"));
  return data;
}

/**
 * Type into a Web Awesome input inside a form.
 * @param {import("@playwright/test").Locator} scope
 * @param {string} name
 * @param {string} value
 */
export async function fill(scope, name, value) {
  await scope.locator(`wa-input[name="${name}"] input`).fill(value);
}
