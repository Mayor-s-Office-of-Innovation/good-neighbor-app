import { adminData, mockAdmin } from "./admin-mock.js";

/**
 * Morgan (a person) and Alex (legacy program staff) manage Example Site, plus a
 * second Site and Program, so specs can move assignments between them.
 */
export function managerData() {
  // Loose typing: tests add fields the base records don't carry.
  /** @type {any} */
  const data = adminData();
  data.programs.push({
    programId: "p3",
    name: "Second Program",
    providerId: "v1",
    status: "active",
  });
  data.sites.push({
    siteId: "s3",
    name: "North Site",
    providerId: "v1",
    leadProgramId: "p1",
    status: "active",
    updatedAt: "2026-10-02T10:00:00Z",
  });
  data.people.push({
    personId: "u3",
    firstName: "Morgan",
    lastName: "Person",
    email: "morgan@example.org",
    phone: "4155550103",
    phoneExtension: "12",
    siteManager: true,
    primaryProgramId: "p1",
    primaryProviderId: "v1",
    status: "active",
    sources: [{ sk: "USER#legacy3" }],
  });
  data.siteItems.s1.push({
    sk: "MEMBERSHIP#m3",
    type: "managerMembership",
    membershipId: "m3",
    personId: "u3",
    name: "Morgan Person",
    email: "morgan@example.org",
    status: "active",
    activeBindingCount: 2,
  });
  data.programUsers.p1.push({
    userId: "u4",
    firstName: "Jordan",
    lastName: "Staff",
    email: "jordan@example.org",
    status: "active",
  });
  return data;
}

/** Access-tab records: one person membership, devices and grants of each kind. */
export function accessData() {
  const data = managerData();
  data.siteItems.s1[1].activeBindingCount = 1;
  data.devices = [
    {
      siteId: "s1",
      bindingId: "b1",
      label: "Front desk phone",
      managerEmail: "morgan@example.org",
      lastSeenAt: "2026-10-29T10:00:00Z",
      status: "active",
    },
    {
      siteId: "s1",
      deviceId: "device-0123456789abcdef",
      enrolledByEmail: "alex@example.org",
      status: "active",
    },
    { siteId: "s1", bindingId: "b3", status: "active" },
    { siteId: "s1", bindingId: "b4", label: "Old phone", status: "revoked" },
  ];
  data.grants = [
    {
      siteId: "s1",
      grantId: "g1",
      issuedTo: "morgan@example.org",
      deliveryMode: "code",
      status: "pending",
      createdAt: "2026-10-28T10:00:00Z",
      expiresAt: "2026-11-04T10:00:00Z",
      deliveryStatus: "accepted",
      securityNotificationStatus: "sent",
      enrollmentUrl: "https://example.org/enroll/g1",
    },
    {
      siteId: "s1",
      grantId: "g2",
      issuedTo: "alex@example.org",
      status: "redeemed",
      createdAt: "2026-10-20T10:00:00Z",
    },
    {
      siteId: "s1",
      grantId: "g3",
      issuedTo: "blair@example.org",
      status: "expired",
    },
  ];
  return data;
}

/**
 * Mock the API with managerData().
 * @param {import("@playwright/test").Page} page
 * @param {{ role?: "compliance-supervisor" | "compliance-manager", data?: ReturnType<typeof managerData> }} [options]
 */
export async function mockManagers(page, options = {}) {
  return mockAdmin(page, { data: managerData(), ...options });
}
