// A seeded year of made-up records plus the totals each Site should reach, to
// check the projection.
// All synthetic: Middle-earth Site names marked "(Synthetic)", made-up
// manager names, example.org emails, 555-01xx phones.

import {
  addDays,
  dayKeysBetween,
  pacificDateKey,
  pacificDayStartIso,
  pacificWallTimeIso,
} from "../../lib/pacific-dates.js";
import { activeCatalog } from "../../analysis/guidance/catalog-registry.js";
import {
  assessmentTimelineGsi,
  checkTimelineGsi,
  taskTimelineGsi,
  taskUpdateTimelineGsi,
  taskWorklistDateGsi,
} from "../../handlers/keys.js";
import { SITE_DAY_METRICS } from "../activity.js";
import { notePhotoLabel } from "../../domain/task-updates.js";

const HOUR = 3_600_000;
const MINUTE = 60_000;

/**
 * What a manager looks for, one pattern per Site profile.
 * @typedef {object} Profile
 * @property {string} key
 * @property {string} looksLike plain description for docs
 * @property {[number, number]} checksPerDay min and max on a working day
 * @property {number} skipRate share of days with no Checks
 * @property {number} issueRate Issues per Check, on average
 * @property {number} severeShare share of Issues at severity 4–5
 * @property {"prompt" | "mixed" | "late" | "none" | "untimed"} response
 * @property {boolean} resolves whether responded Issues get resolved
 * @property {number} singleReportRate single-issue reports per day
 * @property {boolean} publicContact
 * @property {boolean} siteContact
 * @property {number} [opensAt] share of the range before the Site opens
 * @property {number} [closesAt] share of the range after which it is archived
 * @property {[number, number]} [gap] [share of the range, days] with no Checks
 */

/** @type {Profile[]} */
export const PROFILES = [
  {
    key: "steady",
    looksLike: "3 Checks every day, few Issues, answered on time",
    checksPerDay: [3, 3],
    skipRate: 0,
    issueRate: 0.12,
    severeShare: 0.05,
    response: "prompt",
    resolves: true,
    singleReportRate: 0.05,
    publicContact: true,
    siteContact: true,
  },
  {
    key: "gappy",
    looksLike: "Misses days and had a two-week gap",
    checksPerDay: [1, 3],
    skipRate: 0.3,
    issueRate: 0.25,
    severeShare: 0.1,
    response: "mixed",
    resolves: true,
    singleReportRate: 0.05,
    publicContact: true,
    siteContact: true,
    gap: [0.33, 14],
  },
  {
    key: "severe-repeat",
    looksLike: "Repeated severe Issues, often answered late",
    checksPerDay: [2, 3],
    skipRate: 0.05,
    issueRate: 0.9,
    severeShare: 0.6,
    response: "late",
    resolves: true,
    singleReportRate: 0.2,
    publicContact: true,
    siteContact: true,
  },
  {
    key: "overdue",
    looksLike: "Many Issues left unanswered past 72 hours",
    checksPerDay: [2, 3],
    skipRate: 0.1,
    issueRate: 0.5,
    severeShare: 0.2,
    response: "none",
    resolves: false,
    singleReportRate: 0.05,
    publicContact: true,
    siteContact: true,
  },
  {
    key: "long-unresolved",
    looksLike: "Answers on time but Issues stay open for months",
    checksPerDay: [2, 3],
    skipRate: 0.05,
    issueRate: 0.4,
    severeShare: 0.15,
    response: "prompt",
    resolves: false,
    singleReportRate: 0.05,
    publicContact: true,
    siteContact: true,
  },
  {
    key: "no-public-contact",
    looksLike: "No public contact on file",
    checksPerDay: [3, 3],
    skipRate: 0.02,
    issueRate: 0.15,
    severeShare: 0.05,
    response: "prompt",
    resolves: true,
    singleReportRate: 0.05,
    publicContact: false,
    siteContact: true,
  },
  {
    key: "no-site-contact",
    looksLike: "No Site contact designated",
    checksPerDay: [2, 3],
    skipRate: 0.05,
    issueRate: 0.2,
    severeShare: 0.1,
    response: "mixed",
    resolves: true,
    singleReportRate: 0.05,
    publicContact: true,
    siteContact: false,
  },
  {
    key: "reports-only",
    looksLike: "Few Checks, many single-issue reports",
    checksPerDay: [0, 1],
    skipRate: 0.5,
    issueRate: 0.3,
    severeShare: 0.2,
    response: "mixed",
    resolves: true,
    singleReportRate: 0.8,
    publicContact: true,
    siteContact: true,
  },
  {
    key: "new-site",
    looksLike: "Opened mid-year, so early periods are empty",
    checksPerDay: [2, 3],
    skipRate: 0.05,
    issueRate: 0.2,
    severeShare: 0.1,
    response: "prompt",
    resolves: true,
    singleReportRate: 0.05,
    publicContact: true,
    siteContact: true,
    opensAt: 0.55,
  },
  {
    key: "closed-site",
    looksLike: "Archived mid-year; keeps its history",
    checksPerDay: [2, 3],
    skipRate: 0.05,
    issueRate: 0.2,
    severeShare: 0.1,
    response: "mixed",
    resolves: true,
    singleReportRate: 0.05,
    publicContact: true,
    siteContact: true,
    closesAt: 0.5,
  },
  {
    key: "no-checks",
    looksLike: "No Checks at all",
    checksPerDay: [0, 0],
    skipRate: 1,
    issueRate: 0,
    severeShare: 0,
    response: "none",
    resolves: false,
    singleReportRate: 0,
    publicContact: false,
    siteContact: false,
  },
  {
    key: "legacy-untimed",
    looksLike: "Answered, but older records lack the time",
    checksPerDay: [2, 3],
    skipRate: 0.1,
    issueRate: 0.3,
    severeShare: 0.1,
    response: "untimed",
    resolves: false,
    singleReportRate: 0.05,
    publicContact: true,
    siteContact: true,
  },
];

// Real rules, so each task carries the response window the app snapshots
// on it: 48, 24, 4, 72, 96 and 1 hours, plus "Call 911" rules at 0.
const RULES = new Map(activeCatalog().rules.map((rule) => [rule.ruleId, rule]));
const ACTION_RULES = ["LITTER-1", "FECES-1", "GRAFFITI-1", "BLOCK-1", "MED-2"];
const ESCALATION_RULES = [
  "LITTER-2",
  "NEEDLES-1",
  "TENTS-1",
  "BULKY-2",
  "GRAFFITI-2",
];
const NOT_TIMED_RULES = ["MED-1", "DISTRESS-3"];
const DEPARTMENTS = ["DPH", "HSH"];
/** @type {Record<string, string>} */
const DEPARTMENT_NAMES = {
  DPH: "Department of Public Health (DPH)",
  HSH: "Department of Homelessness and Supportive Housing (HSH)",
};
// Insights names managers from Manage's directory, so each needs a person's name.
const MANAGERS = [
  ["Dana", "Ortiz"],
  ["Marcus", "Lee"],
  ["Priya", "Natarajan"],
  ["Tom", "Becker"],
];

// Fictional places, so no name matches a real City Site.
const PLACES = [
  "Rivendell",
  "Bree Street",
  "Hobbiton",
  "Bywater Road",
  "Michel Delving",
  "Tuckborough",
  "Buckland",
  "Crickhollow",
  "Brandywine Bridge",
  "Frogmorton",
  "Edoras",
  "Minas Tirith",
  "Osgiliath",
  "Dol Amroth",
  "Pelargir",
  "Lothlorien",
  "Esgaroth",
  "Dale",
  "Erebor",
  "Grey Havens",
  "Ithilien",
  "Dunharrow",
  "Westfold",
  "Greenway",
  "Archet",
  "Staddle",
  "Combe",
  "Woodhall",
  "Harlond",
  "Belfalas",
];
// Site kinds the City funds, each with the app's own site type.
const SITE_KINDS = [
  ["Navigation Center", "shelter"],
  ["Supportive Housing", "permanent_supportive_housing"],
  ["Drop-in Center", "drop_in"],
  ["SIP Hotel", "other"],
  ["Shelter", "shelter"],
];

/**
 * A unique name for Site s, e.g. "Rivendell Navigation Center (Synthetic)".
 * @param {number} s
 * @returns {{ name: string, siteType: string }}
 */
export function syntheticSite(s) {
  const round = Math.floor(s / (PLACES.length * SITE_KINDS.length));
  // Steps the kind each lap of the places, so no place repeats a kind.
  const [kind, siteType] =
    SITE_KINDS[(s + Math.floor(s / PLACES.length)) % SITE_KINDS.length];
  const place = PLACES[s % PLACES.length];
  return {
    name: `${place} ${kind}${round ? ` ${round + 1}` : ""} (Synthetic)`,
    siteType,
  };
}

/**
 * Where the app stores a Check or Issue update photo; the photo routes refuse
 * any key outside its own Site and Check.
 * @param {string} siteId
 * @param {string} checkId
 * @param {string} artifactId
 * @returns {{ s3Key: string, thumbS3Key: string }}
 */
function photoKeysFor(siteId, checkId, artifactId) {
  const s3Key = `checks/${siteId}/${checkId}/${artifactId}`;
  return { s3Key, thumbS3Key: `${s3Key}.thumb.webp` };
}

// Seeded, since Math.random would make every run differ.
/**
 * @param {number} seed
 * @returns {() => number}
 */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {number} n
 * @returns {string}
 */
const pad = (n) => String(n).padStart(2, "0");

/**
 * @typedef {object} Answers
 * @property {Record<string, Record<string, number>>} bySiteMonth key `${siteId}|YYYY-MM`
 * @property {Record<string, { publicContact: string, siteContact: string }>} contacts
 * @property {Record<string, string>} profiles siteId → profile key
 */

/**
 * @param {{ seed?: number, sites?: number, startDay?: string, evaluatedAt?: string, photosPerCheck?: [number, number] }} [opts]
 * @returns {{ items: Record<string, any>[], answers: Answers, evaluatedAt: string, startDay: string }}
 */
export function generateYear(opts = {}) {
  const seed = opts.seed ?? 410;
  const siteCount = opts.sites ?? 24;
  const startDay = opts.startDay ?? "2025-11-01";
  const evaluatedAt = opts.evaluatedAt ?? "2026-11-04T19:00:00.000Z";
  const [minPhotos, maxPhotos] = opts.photosPerCheck ?? [1, 3];
  const rand = seededRandom(seed);
  const pick = (/** @type {any[]} */ list) =>
    list[Math.floor(rand() * list.length)];
  const between = (/** @type {number} */ lo, /** @type {number} */ hi) =>
    lo + Math.floor(rand() * (hi - lo + 1));
  const cutoff = Date.parse(evaluatedAt);
  const lastDay = pacificDateKey(evaluatedAt);
  const days = dayKeysBetween(startDay, addDays(lastDay, 1));
  if (!days.length)
    throw new Error("startDay must be on or before evaluatedAt");
  const yearStart = pacificDayStartIso(startDay);
  const at = (/** @type {string} */ day, /** @type {number} */ minutes) =>
    pacificWallTimeIso(day, minutes * MINUTE);
  const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();

  /** @type {Record<string, any>[]} */
  const items = [];
  /** @type {Answers} */
  const answers = { bySiteMonth: {}, contacts: {}, profiles: {} };
  const tally = (
    /** @type {string} */ siteId,
    /** @type {string} */ day,
    /** @type {string} */ metric,
  ) => {
    const k = `${siteId}|${day.slice(0, 7)}`;
    answers.bySiteMonth[k] ??= Object.fromEntries(
      SITE_DAY_METRICS.map((m) => [m, 0]),
    );
    answers.bySiteMonth[k][metric] += 1;
  };

  const providers = ["syn-provider-a", "syn-provider-b", "syn-provider-c"];
  providers.forEach((providerId, i) => {
    const name = `Synthetic Provider ${"ABC"[i]}`;
    items.push(
      {
        pk: `PROVIDER#${providerId}`,
        sk: "#META",
        type: "provider",
        entityType: "PROVIDER",
        providerId,
        name,
        status: "active",
        createdAt: yearStart,
        updatedAt: yearStart,
      },
      // Manage's provider list, which Insights names providers from, reads these.
      {
        pk: "PROVIDER_SEARCH#ACTIVE",
        sk: providerId,
        type: "providerSearch",
        providerId,
        name,
        searchText: name.toLowerCase(),
        status: "active",
        updatedAt: yearStart,
      },
    );
  });
  MANAGERS.forEach(([firstName, lastName], i) =>
    items.push({
      pk: "ADMIN_DIRECTORY#PROGRAM_MANAGERS",
      sk: `MANAGER#manager${i + 1}@example.org`,
      type: "cityProgramManager",
      entityType: "COMPLIANCE_MANAGER_DIRECTORY",
      userId: `syn-manager-${i + 1}`,
      firstName,
      lastName,
      name: `${firstName} ${lastName}`,
      email: `manager${i + 1}@example.org`,
      phone: `415-555-019${i}`,
      phoneExtension: "",
      // Site s gets manager (s % 4) + 1 and department s % 2, so these agree.
      departmentName: DEPARTMENT_NAMES[DEPARTMENTS[i % 2]],
      status: "active",
      createdAt: yearStart,
      updatedAt: yearStart,
    }),
  );
  const programs = providers.flatMap((providerId, i) =>
    [`syn-program-${i * 2 + 1}`, `syn-program-${i * 2 + 2}`].map(
      (programId) => ({ programId, providerId }),
    ),
  );
  for (const { programId, providerId } of programs)
    items.push({
      pk: `PROGRAM#${programId}`,
      sk: "#META",
      type: "program",
      entityType: "PROGRAM",
      programId,
      name: `Synthetic Program ${programId.slice(-1)}`,
      providerId,
      providerName: `Synthetic Provider ${"ABC"[providers.indexOf(providerId)]}`,
      status: "active",
      createdAt: yearStart,
      updatedAt: yearStart,
    });

  let ticket = 1000;
  let lastWithPublicContact = -1;
  for (let s = 0; s < siteCount; s += 1)
    if (PROFILES[s % PROFILES.length].publicContact) lastWithPublicContact = s;
  for (let s = 0; s < siteCount; s += 1) {
    const profile = PROFILES[s % PROFILES.length];
    const siteId = `syn-site-${pad(s + 1)}`;
    const { name: siteName, siteType } = syntheticSite(s);
    const pk = `SITE#${siteId}`;
    const { programId, providerId } = programs[s % programs.length];
    const managerId = `syn-manager-${(s % 4) + 1}`;
    const userId = `syn-user-${pad(s + 1)}`;
    const first = Math.floor((profile.opensAt ?? 0) * days.length);
    const last =
      profile.closesAt === undefined
        ? Infinity
        : Math.min(Math.floor(profile.closesAt * days.length), days.length - 1);
    const gapStart = profile.gap
      ? Math.floor(profile.gap[0] * days.length)
      : -1;
    const createdDay = days[first];
    const archived = last !== Infinity;
    // One Site keeps a stored contact the app's own check would reject.
    const invalidStored = s === lastWithPublicContact;
    // Some posted contacts lack one part, so pages show which part is missing.
    const lacks = invalidStored
      ? ""
      : ["", "", "phone", "", "", "", "email", ""][s % 8];
    const publicContact = !profile.publicContact
      ? undefined
      : {
          email: invalidStored
            ? "front desk"
            : lacks === "email"
              ? ""
              : `site${pad(s + 1)}@example.org`,
          phone: lacks === "phone" ? "" : `415-555-01${pad((s * 2) % 100)}`,
          // Some posted lines go to a front desk extension.
          phoneExtension: lacks !== "phone" && s % 3 === 0 ? `${100 + s}` : "",
        };
    items.push({
      pk,
      sk: "#META",
      type: "site",
      entityType: "SITE",
      siteId,
      name: siteName,
      siteType,
      status: archived ? "inactive" : "active",
      providerId,
      providerName: `Synthetic Provider ${"ABC"[providers.indexOf(providerId)]}`,
      leadProgramId: programId,
      programName: `Synthetic Program ${programId.slice(-1)}`,
      address: `${100 + s} Example Street, San Francisco, CA 94103`,
      addressParts: {
        streetAddress: `${100 + s} Example Street`,
        city: "San Francisco",
        state: "CA",
        postalCode: "94103",
      },
      providerSiteId: `provider-site-${siteId}`,
      deliberate311ProductionEnabled: true,
      managerRosterRevision: `syn-roster-${pad(s + 1)}`,
      ...(s % 5 === 4
        ? {}
        : {
            location: {
              latitude: 37.77 + s * 0.001,
              longitude: -122.42 + s * 0.001,
            },
          }),
      ...(s % 6 === 5
        ? {}
        : { perimeter: "Front sidewalk and the alley on the east side" }),
      ...(publicContact ? { publicContact } : {}),
      ...(profile.siteContact
        ? {
            primaryContactUserId: userId,
            primaryContact: {
              firstName: "Synthetic",
              lastName: `Contact ${pad(s + 1)}`,
              email: `contact${pad(s + 1)}@example.org`,
              phone: `415-555-01${pad((s * 2 + 1) % 100)}`,
              phoneExtension: "",
            },
          }
        : {}),
      oversight: {
        managingCityDepartment: DEPARTMENTS[s % 2],
        managingSystemOfCare: "",
        cityProgramManagerId: managerId,
        cityProgramManager: MANAGERS[s % 4].join(" "),
      },
      // Midnight, so the Site exists before its first day's Checks.
      createdAt: at(createdDay, 0),
      // Archived late on its last day, after that day's Checks.
      updatedAt: archived
        ? iso(Math.min(cutoff, Date.parse(at(days[last], 23 * 60 + 30))))
        : at(createdDay, 0),
    });
    answers.profiles[siteId] = profile.key;
    answers.contacts[siteId] = {
      publicContact:
        !profile.publicContact || lacks
          ? "missing"
          : invalidStored
            ? "unknown"
            : "available",
      siteContact: profile.siteContact ? "available" : "missing",
    };
    items.push(
      {
        pk: `PROGRAM#${programId}`,
        sk: `SITE#${siteId}`,
        type: "programSiteMembership",
        programId,
        programName: `Synthetic Program ${programId.slice(-1)}`,
        siteId,
        siteName,
        status: "active",
        createdAt: at(createdDay, 0),
        updatedAt: at(createdDay, 0),
      },
      {
        pk: `PROVIDER#${providerId}`,
        sk: `SITE#${siteId}`,
        type: "providerSiteMembership",
        providerId,
        providerName: `Synthetic Provider ${"ABC"[providers.indexOf(providerId)]}`,
        providerSiteId: `provider-site-${siteId}`,
        siteId,
        siteName,
        status: "active",
        createdAt: at(createdDay, 0),
        updatedAt: at(createdDay, 0),
      },
      {
        pk,
        sk: `COMPLIANCE_MANAGER#${managerId}`,
        type: "siteComplianceManagerAssignment",
        entityType: "SITE_COMPLIANCE_MANAGER_ASSIGNMENT",
        siteId,
        managerId,
        email: `manager${managerId.slice(-1)}@example.org`,
        status: "active",
        createdAt: at(createdDay, 0),
      },
      {
        pk,
        sk: `DEVICE#syn-device-${pad(s + 1)}`,
        type: "device",
        deviceId: `syn-device-${pad(s + 1)}`,
        siteId,
        siteName,
        accessLevel: "site",
        registeredAt: at(createdDay, 0),
        label: `Front desk tablet ${pad(s + 1)}`,
        lastSeenAt: iso(
          Math.min(
            cutoff,
            Date.parse(at(archived ? days[last] : lastDay, 21 * 60)),
          ),
        ),
      },
    );
    if (profile.siteContact)
      items.push(
        {
          pk: `PROGRAM#${programId}`,
          sk: `USER#${userId}`,
          type: "programUser",
          entityType: "PROGRAM_USER",
          programId,
          userId,
          firstName: "Synthetic",
          lastName: `Contact ${pad(s + 1)}`,
          email: `contact${pad(s + 1)}@example.org`,
          phone: `415-555-01${pad((s * 2 + 1) % 100)}`,
          phoneExtension: "",
          siteManager: true,
          siteAssignmentCount: 1,
          status: "active",
          createdAt: at(createdDay, 0),
          updatedAt: at(createdDay, 0),
        },
        {
          pk,
          sk: `ASSIGNED_USER#${userId}`,
          type: "siteUserAssignment",
          siteId,
          programId,
          userId,
          firstName: "Synthetic",
          lastName: `Contact ${pad(s + 1)}`,
          email: `contact${pad(s + 1)}@example.org`,
          phone: `415-555-01${pad((s * 2 + 1) % 100)}`,
          phoneExtension: "",
          status: "active",
          createdAt: at(createdDay, 0),
          updatedAt: at(createdDay, 0),
        },
      );

    /** @type {{ taskId: string, createdMs: number, day: string }[]} */
    const recentIssues = [];
    let checkNo = 0;
    let taskNo = 0;

    // Marks a card replaced, as deletion.js and guidance-store.js do.
    /**
     * @param {Record<string, any>} task
     * @param {Record<string, string>} why
     * @param {number} whenMs
     * @returns {Record<string, any>}
     */
    const retire = (task, why, whenMs) =>
      Object.assign(task, {
        status: "superseded",
        ...why,
        supersededAt: iso(whenMs),
        updatedAt: iso(whenMs),
      });

    /**
     * A note or photo update with its media rows, as task-update-store.js writes them.
     * @param {Record<string, any>} task
     * @param {string} suffix
     * @param {"note_photo_update" | "resolution_proof"} type
     * @param {number} whenMs
     * @param {{ notes: string[], photos: number }} content
     */
    const addUpdate = (task, suffix, type, whenMs, { notes, photos }) => {
      const { taskId, checkId } = task;
      const at = iso(whenMs);
      const updateId = `${taskId}-${suffix}`;
      const photoKeys = Array.from(
        { length: photos },
        (_, i) => `${taskId}-${suffix}-p${i + 1}`,
      );
      items.push(
        {
          pk,
          sk: `TASK#${taskId}#UPDATE#${at}#${updateId}`,
          entityType: "task_update",
          taskId,
          updateId,
          type,
          label: notePhotoLabel(notes, photoKeys),
          actorId: "site-team",
          ...(notes.length ? { notes } : {}),
          ...(photoKeys.length ? { photoKeys } : {}),
          occurredAt: at,
          documentationState: "closed",
        },
        {
          pk,
          sk: `TASK#${taskId}#UPDATE_ID#${updateId}`,
          entityType: "task_update_pointer",
          taskId,
          updateId,
          updateSk: `TASK#${taskId}#UPDATE#${at}#${updateId}`,
        },
        ...photoKeys.flatMap((photoId) => [
          {
            pk,
            sk: `TASK#${taskId}#MEDIA#${photoId}`,
            entityType: "task_update_media",
            taskId,
            checkId,
            artifactId: photoId,
            purpose: "task_update",
            ...photoKeysFor(siteId, checkId, photoId),
            contentType: "image/jpeg",
            contentLength: 120_000,
            capturedAt: at,
          },
          {
            pk,
            sk: `CHECK#${checkId}#UPDATE_MEDIA#${photoId}`,
            entityType: "task_update_media_pointer",
            mediaSk: `TASK#${taskId}#MEDIA#${photoId}`,
            checkId,
            artifactId: photoId,
            taskId,
          },
        ]),
      );
    };

    /**
     * @param {string} checkId
     * @param {string} artifactId
     * @param {string} day intended Pacific day
     * @param {number} createdMs
     * @param {boolean} counts false for records that must not count
     * @param {boolean} respond false for sightings staff leave alone
     * @returns {{ task: Record<string, any>, condition: Record<string, any>, state: string, severity: number }}
     */
    const addIssue = (
      checkId,
      artifactId,
      day,
      createdMs,
      counts = true,
      respond = true,
    ) => {
      taskNo += 1;
      const taskId = `${siteId}-t${taskNo}`;
      const assessmentId = `${checkId}-${artifactId}`;
      const conditionId = `cond-${taskNo}`;
      const severity =
        rand() < profile.severeShare ? between(4, 5) : between(1, 3);
      const ruleRoll = rand();
      const rule = /** @type {any} */ (
        RULES.get(
          ruleRoll < 0.04
            ? pick(NOT_TIMED_RULES)
            : ruleRoll < 0.34
              ? pick(ESCALATION_RULES)
              : pick(ACTION_RULES),
        )
      );
      const escalation = rule.outcome.kind === "escalation";
      // Older records predate rule IDs and windows, so they get 72 hours.
      const legacy = profile.response === "untimed";
      const hours = legacy ? 72 : rule.maxAcceptableResponseHours;
      const limit = hours * HOUR;
      const createdAt = iso(createdMs);
      /** @type {Record<string, any>} */
      const task = {
        pk,
        sk: `TASK#${taskId}`,
        entityType: "TASK",
        taskId,
        shortId: `S${pad(s + 1)}-${taskNo}`,
        assessmentId,
        checkId,
        conditionId,
        ...(legacy
          ? {}
          : {
              policyVersion: rule.policyVersion,
              ruleId: rule.ruleId,
              maxAcceptableResponseHours: hours,
            }),
        canBeInProgress: rule.canBeInProgress,
        primaryInProgressAgency: rule.primaryInProgressAgency,
        kind: rule.outcome.kind,
        type: rule.outcome.kind === "action" ? "onsite" : "city_escalation",
        status: "open",
        category: rule.category,
        analyzerCategory: rule.category,
        severity,
        userFriendlyLabel: `Synthetic condition ${taskNo}`,
        label: rule.outcome.label,
        description: `Synthetic description ${taskNo}`,
        guidance: rule.outcome.guidance,
        buttons: rule.outcome.buttons,
        appActions: rule.outcome.appActions,
        // Same as initialAppActionStatus(), whose module needs AWS clients.
        appActionStatus: rule.outcome.appActions?.length ? "pending" : "none",
        appActionResults: [],
        category311: rule.outcome.category311,
        phoneNumber: rule.outcome.phoneNumber || "",
        sourceArtifactIds: [artifactId],
        source: { latitude: 37.77 + s * 0.001, longitude: -122.42 + s * 0.001 },
        createdAt,
        updatedAt: createdAt,
      };
      const condition = {
        pk,
        sk: `ASSESSMENT#${assessmentId}#COND#${conditionId}`,
        entityType: "CONDITION",
        assessmentId,
        conditionId,
        checkId,
        policyVersion: rule.policyVersion,
        severity,
        severityLabel: `Severity ${severity}`,
        analyzerCategory: task.category,
        canonicalCategory: task.category,
        userFriendlyLabel: task.userFriendlyLabel,
        description: task.description,
        answers: {},
        status: "tasks_created",
        selectedRuleId: rule.ruleId,
        outcome: rule.outcome,
        taskIds: [taskId],
        resolvedToTasks: true,
        needsAnswer: null,
        source: {
          artifactIds: [artifactId],
          evidenceIndices: [0],
          reportedAt: createdAt,
        },
        createdAt,
        updatedAt: createdAt,
      };
      items.push(condition);

      // In 72nds of the window, so the exact edge and one second past it both
      // occur. A 0-hour rule is timed as if it had 72.
      const unit = (limit || 72 * HOUR) / 72;
      /** @type {number | null | "untimed"} */
      let delay = null;
      const r = rand();
      if (!respond) delay = null;
      else if (profile.response === "prompt")
        delay =
          r < 0.9
            ? between(1, 48) * unit
            : r < 0.97
              ? 72 * unit
              : 72 * unit + 1000;
      else if (profile.response === "mixed")
        delay =
          r < 0.5
            ? between(1, 70) * unit
            : r < 0.75
              ? between(73, 200) * unit
              : null;
      else if (profile.response === "late")
        delay =
          r < 0.25
            ? between(2, 70) * unit
            : r < 0.9
              ? between(73, 400) * unit
              : null;
      else if (profile.response === "untimed")
        delay = r < 0.6 ? "untimed" : r < 0.8 ? between(2, 60) * HOUR : null;
      const responseMs =
        typeof delay === "number" ? createdMs + Math.round(delay) : null;
      const seen = responseMs !== null && responseMs <= cutoff;
      let state;
      if (hours === 0) state = "notTimed";
      else if (delay === "untimed") state = "unknown";
      else if (!seen)
        state = cutoff > createdMs + limit ? "overdue" : "awaiting";
      else
        state =
          /** @type {number} */ (responseMs) <= createdMs + limit
            ? "onTime"
            : "late";

      if (delay === "untimed") {
        task.status = "in_progress";
      } else if (seen) {
        const respondedAt = iso(/** @type {number} */ (responseMs));
        const resolved = profile.resolves && rand() < 0.7;
        const updateId = `${taskId}-u1`;
        const type = escalation
          ? "311_ticket_filed"
          : resolved
            ? "task_completed"
            : "escalation_action_taken";
        items.push(
          {
            pk,
            sk: `TASK#${taskId}#UPDATE#${respondedAt}#${updateId}`,
            entityType: "task_update",
            taskId,
            updateId,
            type,
            label: "Synthetic update",
            occurredAt: respondedAt,
            actorId: "site-team",
            documentationState: "closed",
          },
          {
            pk,
            sk: `TASK#${taskId}#UPDATE_ID#${updateId}`,
            entityType: "task_update_pointer",
            taskId,
            updateId,
            updateSk: `TASK#${taskId}#UPDATE#${respondedAt}#${updateId}`,
          },
        );
        if (escalation) {
          ticket += 1;
          // A City closure after the snapshot mustn't mark the Issue resolved.
          const closed =
            resolved &&
            /** @type {number} */ (responseMs) + 24 * HOUR <= cutoff;
          Object.assign(task, {
            status: closed ? "completed" : "in_progress",
            inProgressAt: respondedAt,
            inProgressActionKind: "311_filed",
            agency: "311",
            appActionResults: [
              {
                code: "create_311_ticket",
                status: "submitted",
                payload: { tickets: [{ srNum: `SYN-${ticket}` }] },
              },
              ...(closed
                ? [
                    {
                      code: "close_311_ticket",
                      status: "closed",
                      payload: {
                        closures: [
                          { srNum: `SYN-${ticket}`, status: "closed" },
                        ],
                      },
                    },
                  ]
                : []),
            ],
            ...(closed
              ? {
                  completedAt: iso(
                    /** @type {number} */ (responseMs) + 24 * HOUR,
                  ),
                  resolvedAt: iso(
                    /** @type {number} */ (responseMs) + 24 * HOUR,
                  ),
                  completionMethod: "311_filed",
                }
              : {}),
          });
          items.push({
            pk,
            sk: `SF311_JOB#${taskId}#filed-${updateId}`,
            entityType: "SF311_OUTBOX",
            siteId,
            taskId,
            actorId: "site-team",
            status: "complete",
            trigger: "user_confirmed",
            createdAt: respondedAt,
          });
        } else if (resolved) {
          Object.assign(task, {
            status: "completed",
            completedAt: respondedAt,
            resolvedAt: respondedAt,
            completionMethod: "user_confirmed",
          });
        } else {
          Object.assign(task, {
            status: "in_progress",
            inProgressAt: respondedAt,
            notifiedAt: respondedAt,
          });
        }
        // Later notes and photos in each shape the app takes; they never count as Issues.
        const noteMs = /** @type {number} */ (responseMs) + 6 * HOUR;
        const shape = rand();
        const noteAdded = shape < 0.4 && noteMs <= cutoff;
        if (noteAdded)
          addUpdate(task, "u2", "note_photo_update", noteMs, {
            notes:
              shape < 0.1
                ? []
                : shape < 0.3
                  ? ["Synthetic note: bags moved to the curb"]
                  : [
                      "Synthetic note: called the property manager",
                      "Synthetic note: will check again tomorrow",
                    ],
            photos: shape < 0.1 ? 1 : shape < 0.2 ? 0 : shape < 0.3 ? 1 : 2,
          });
        // Proof of a fix, as staff add after resolving an on-site Issue.
        const proofMs = noteMs + HOUR;
        const proofAdded =
          task.status === "completed" &&
          !escalation &&
          rand() < 0.4 &&
          proofMs <= cutoff;
        if (proofAdded)
          addUpdate(task, "u3", "resolution_proof", proofMs, {
            notes: [],
            photos: 1,
          });
        task.updatedAt = iso(
          Math.max(
            Date.parse(task.updatedAt),
            /** @type {number} */ (responseMs),
            Date.parse(task.completedAt ?? "") || 0,
            noteAdded ? noteMs : 0,
            proofAdded ? proofMs : 0,
          ),
        );
      }
      items.push(task);
      if (counts) {
        const createdDay = pacificDateKey(createdMs);
        tally(siteId, createdDay, "issuesCreated");
        tally(siteId, createdDay, state);
        if (severity >= 4) tally(siteId, createdDay, "severeIssues");
      }
      return { task, condition, state, severity };
    };

    for (const [index, day] of days.entries()) {
      if (index < first || index > last) continue;
      if (profile.gap && index >= gapStart && index < gapStart + profile.gap[1])
        continue;
      const working = rand() >= profile.skipRate;
      const dst =
        Date.parse(at(addDays(day, 1), 0)) - Date.parse(at(day, 0)) !==
        24 * HOUR;
      const checks = working ? between(...profile.checksPerDay) : 0;
      // On 23- and 25-hour days, Checks near midnight test the day boundary.
      const starts = Array.from({ length: checks }, (_, i) =>
        dst && i === 0
          ? 30
          : dst && i === checks - 1
            ? 23 * 60 + 25
            : 7 * 60 + i * 300 + between(0, 120),
      );
      const reports = rand() < profile.singleReportRate ? 1 : 0;
      for (let i = 0; i < checks + reports; i += 1) {
        const single = i >= checks;
        checkNo += 1;
        const checkId = `${siteId}-c${checkNo}`;
        const startMs = Date.parse(
          at(day, single ? between(8 * 60, 20 * 60) : starts[i]),
        );
        if (startMs > cutoff) continue;
        const unfinished = !single && rand() < 0.02;
        // What staff captured: photos, a typed description, or both.
        const evidenceRoll = rand();
        const kinds = single
          ? ["photo"]
          : evidenceRoll < 0.05
            ? ["text"]
            : [
                ...Array(between(minPhotos, maxPhotos)).fill("photo"),
                ...(evidenceRoll < 0.12 ? ["text"] : []),
              ];
        const photos = kinds.length;
        const doneMs = startMs + (photos + between(1, 2)) * MINUTE;
        if (doneMs > cutoff) continue;
        /** @type {Record<string, any>} */
        const header = {
          pk,
          sk: `CHECK#${checkId}`,
          checkId,
          status: unfinished ? "in_progress" : "completed",
          flowType: single ? "single-problem" : "perimeter",
          startedAt: iso(startMs),
          issueCount: 0,
          maxSeverity: 0,
        };
        let maxSeverity = 0;
        let issueCount = 0;
        for (let p = 0; p < photos; p += 1) {
          const artifactId = `art-${p + 1}`;
          const typed = kinds[p] === "text";
          const capturedAt = iso(startMs + (p + 1) * MINUTE);
          const assessmentId = `${checkId}-${artifactId}`;
          const grade = pick(["Excellent", "Good", "Fair", "Poor"]);
          /** @type {Record<string, any>} */
          const assessment = {
            pk,
            sk: `ASSESSMENT#${assessmentId}`,
            assessmentId,
            checkId,
            entityType: "ASSESSMENT",
            status: "no_tasks",
            policyVersion: RULES.get("LITTER-1")?.policyVersion,
            rubricVersion: "1.0.0",
            grade,
            reportedAt: capturedAt,
            assessmentRevision: 0,
            lineageId: artifactId,
            createdAt: capturedAt,
            updatedAt: capturedAt,
          };
          /** @type {Record<string, any>} */
          const pointer = {
            pk,
            sk: `GUIDANCE_CURRENT#${JSON.stringify([checkId, artifactId])}`,
            entityType: "GUIDANCE_CURRENT",
            assessmentId,
          };
          /** @type {Record<string, any>} */
          const analysis = {
            pk,
            sk: `CHECK#${checkId}#ANALYSIS#${artifactId}`,
            checkId,
            artifactId,
            status: "analyzed",
            analysisId: `${assessmentId}-an`,
            rubricVersion: "1.0.0",
            model: { provider: "synthetic", model_id: "synthetic-1" },
            grade,
            capturedAt,
            analyzedAt: capturedAt,
            latitude: 37.77 + s * 0.001,
            longitude: -122.42 + s * 0.001,
            analysisGeneration: artifactId,
            issueCount: 0,
            maxSeverity: 0,
            concerns: [],
          };
          items.push(
            assessment,
            {
              pk,
              sk: `CHECK#${checkId}#ART#${artifactId}`,
              checkId,
              artifactId,
              // A typed description has text and no file, as checks.js counts it.
              ...(typed
                ? { text: "Synthetic description: overflowing bin by the gate" }
                : {
                    ...photoKeysFor(siteId, checkId, artifactId),
                    contentType: "image/jpeg",
                    contentLength: 240_000,
                  }),
              capturedAt,
              receivedAt: capturedAt,
              latitude: 37.77 + s * 0.001,
              longitude: -122.42 + s * 0.001,
              accuracyMeters: 8,
              analysisGeneration: artifactId,
              analysisStatus: "succeeded",
            },
            analysis,
            pointer,
          );
          if (unfinished) continue;
          const issues =
            single && p === 0 ? 1 : rand() < profile.issueRate / photos ? 1 : 0;
          for (let k = 0; k < issues; k += 1) {
            const createdMs = startMs + (p + 1) * MINUTE + 30_000;
            const roll = rand();
            const recent = recentIssues.filter(
              (x) =>
                createdMs - x.createdMs < 72 * HOUR && x.createdMs < createdMs,
            );
            if (
              roll < 0.06 &&
              recent.length &&
              createdMs + 2 * MINUTE <= cutoff
            ) {
              // A duplicate sighting of a recent Issue: one Issue, not two.
              const original = recent[recent.length - 1];
              const dup = addIssue(
                checkId,
                artifactId,
                day,
                createdMs,
                false,
                false,
              );
              if (rand() < 0.2) {
                // Staff separated it, so the app replaced the sighting with a fresh card.
                // handlers/duplicate-links.js points the old card at the new one.
                retire(
                  dup.task,
                  { supersededByTaskId: `${dup.task.taskId}-r` },
                  createdMs + 2 * MINUTE,
                );
                /** @type {Record<string, any>} */
                const restored = {
                  ...dup.task,
                  sk: `TASK#${dup.task.taskId}-r`,
                  taskId: `${dup.task.taskId}-r`,
                  shortId: `${dup.task.shortId}R`,
                  status: "open",
                  appActionResults: [],
                };
                delete restored.supersededAt;
                delete restored.supersededByTaskId;
                dup.condition.taskIds = [restored.taskId];
                items.push(
                  restored,
                  {
                    pk,
                    sk: `DUP_LINK#${dup.task.taskId}`,
                    ...dupLinkFields(dup.task, original.taskId),
                    occurredAt: iso(createdMs + MINUTE),
                  },
                  {
                    pk,
                    sk: `DUP_OVERRIDE#${JSON.stringify([checkId, artifactId, dup.task.conditionId])}`,
                    taskId: dup.task.taskId,
                    restoredTaskId: restored.taskId,
                    originalTaskId: original.taskId,
                    sourceRevision: 0,
                    actorId: "site-team",
                    occurredAt: iso(createdMs + 2 * MINUTE),
                  },
                );
                // The fresh card keeps the sighting's time, with no response.
                const createdDay = pacificDateKey(createdMs);
                tally(siteId, createdDay, "issuesCreated");
                tally(siteId, createdDay, dup.state);
                if (dup.severity >= 4)
                  tally(siteId, createdDay, "severeIssues");
              } else
                items.push({
                  pk,
                  sk: `DUP_LINK#${dup.task.taskId}`,
                  ...dupLinkFields(dup.task, original.taskId),
                  occurredAt: iso(createdMs + MINUTE),
                });
            } else if (roll < 0.09 && createdMs + MINUTE <= cutoff) {
              // A refreshed assessment: the old one points to its
              // replacement, and the photo's current guidance moves to it.
              assessment.supersededByAssessmentId = `${assessmentId}-r2`;
              pointer.assessmentId = `${assessmentId}-r2`;
              items.push({
                pk,
                sk: `ASSESSMENT#${assessmentId}-r2`,
                assessmentId: `${assessmentId}-r2`,
                checkId,
                entityType: "ASSESSMENT",
                status: "tasks_created",
                policyVersion: assessment.policyVersion,
                rubricVersion: "1.0.0",
                grade: assessment.grade,
                reportedAt: iso(createdMs + MINUTE),
                assessmentRevision: 1,
                lineageId: artifactId,
                createdAt: iso(createdMs + MINUTE),
                updatedAt: iso(createdMs + MINUTE),
              });
              if (rand() < 0.5) {
                // Unchanged condition: its task stays, under the old assessment ID.
                const kept = addIssue(checkId, artifactId, day, createdMs);
                items.push({
                  ...kept.condition,
                  sk: `ASSESSMENT#${assessmentId}-r2#COND#${kept.condition.conditionId}`,
                  assessmentId: `${assessmentId}-r2`,
                });
                recentIssues.push({ taskId: kept.task.taskId, createdMs, day });
                maxSeverity = Math.max(maxSeverity, kept.severity);
                issueCount += 1;
                continue;
              }
              // Changed condition: the untouched old task is replaced.
              const old = addIssue(
                checkId,
                artifactId,
                day,
                createdMs,
                false,
                false,
              );
              retire(
                old.task,
                { supersessionReason: "assessment_refreshed" },
                createdMs + MINUTE,
              );
              const fresh = addIssue(
                checkId,
                artifactId,
                day,
                createdMs + MINUTE,
              );
              fresh.task.assessmentId = `${assessmentId}-r2`;
              fresh.condition.assessmentId = `${assessmentId}-r2`;
              fresh.condition.sk = `ASSESSMENT#${assessmentId}-r2#COND#${fresh.condition.conditionId}`;
              recentIssues.push({
                taskId: fresh.task.taskId,
                createdMs: createdMs + MINUTE,
                day,
              });
              maxSeverity = Math.max(maxSeverity, fresh.severity);
            } else if (roll < 0.11 && createdMs + HOUR <= cutoff) {
              // Deleted by staff as a wrong detection.
              // No response: the app won't act on a deleted card.
              const gone = addIssue(
                checkId,
                artifactId,
                day,
                createdMs,
                false,
                false,
              );
              // deletion.js marks the card superseded, with a receipt.
              retire(
                gone.task,
                { supersessionReason: "issue_deleted" },
                createdMs + HOUR,
              );
              items.push({
                pk,
                sk: `ISSUE_DELETION#${checkId}:${artifactId}:${gone.task.conditionId}`,
                state: "confirmed",
                deletionOrigin: "app",
                category: gone.task.category,
                deletionTargets: [{ taskId: gone.task.taskId }],
                deletedAt: iso(createdMs + HOUR),
              });
            } else {
              const made = addIssue(checkId, artifactId, day, createdMs);
              recentIssues.push({ taskId: made.task.taskId, createdMs, day });
              if (rand() < 0.05) {
                // A follow-up task on the same condition is more work, not another Issue.
                taskNo += 1;
                /** @type {Record<string, any>} */
                const followUp = {
                  ...made.task,
                  sk: `TASK#${siteId}-t${taskNo}`,
                  taskId: `${siteId}-t${taskNo}`,
                  shortId: `S${pad(s + 1)}-${taskNo}`,
                  status: "open",
                  createdAt: iso(createdMs + HOUR),
                  updatedAt: iso(createdMs + HOUR),
                  appActionResults: [],
                };
                for (const field of [
                  "inProgressAt",
                  "completedAt",
                  "resolvedAt",
                  "completionMethod",
                  "notifiedAt",
                  "inProgressActionKind",
                  "agency",
                ])
                  delete followUp[field];
                if (createdMs + HOUR <= cutoff) {
                  made.condition.taskIds = [
                    ...made.condition.taskIds,
                    followUp.taskId,
                  ];
                  items.push(followUp);
                }
              }
              maxSeverity = Math.max(maxSeverity, made.severity);
            }
            issueCount += 1;
          }
          if (issues) {
            assessment.status = "tasks_created";
            analysis.issueCount = issues;
          }
        }
        if (!unfinished) {
          Object.assign(header, {
            status: "completed",
            completedAt: iso(doneMs),
            synthesizedAt: iso(doneMs),
            grade: pick(["Excellent", "Good", "Fair", "Poor"]),
            rubricVersion: "1.0.0",
            categories: [],
            ...evidenceSummary(kinds),
            issueCount,
            maxSeverity,
          });
          // A Check counts on the day it finished, which may be after midnight.
          const doneDay = pacificDateKey(doneMs);
          if (!single)
            items.push({
              pk,
              sk: `CHECK_COMPLETION#${doneDay}#${iso(doneMs)}#${checkId}`,
              checkId,
              completedAt: iso(doneMs),
            });
          tally(
            siteId,
            doneDay,
            single ? "singleIssueReports" : "completedPerimeterChecks",
          );
        } else tally(siteId, day, "unfinishedChecks");
        items.push(header);
      }
      while (
        recentIssues.length &&
        Date.parse(at(day, 0)) - recentIssues[0].createdMs > 72 * HOUR
      )
        recentIssues.shift();
    }
  }
  for (const item of items) Object.assign(item, gsiKeys(item));
  return { items, answers, evaluatedAt, startDay };
}

/**
 * @param {Record<string, any>} task the sighting
 * @param {string} originalTaskId
 * @returns {Record<string, any>}
 */
function dupLinkFields(task, originalTaskId) {
  return {
    taskId: task.taskId,
    originalTaskId,
    checkId: task.checkId,
    artifactId: task.sourceArtifactIds[0],
    conditionId: task.conditionId,
    matchedObservationId: `obs-${originalTaskId}`,
    sourceRevision: 0,
    updateId: `${task.taskId}-dup`,
  };
}

// So the admin worklists can browse the year. Status keys are stamped once
// from the final status; the app restamps them on each change.
/**
 * @param {Record<string, any>} item
 * @returns {Record<string, string>}
 */
function gsiKeys(item) {
  const siteId = String(item.pk).slice(5);
  if (/^CHECK#[^#]+$/.test(item.sk))
    return checkTimelineGsi(siteId, item.startedAt);
  if (/^ASSESSMENT#[^#]+$/.test(item.sk))
    return assessmentTimelineGsi(siteId, item.reportedAt, item.assessmentId);
  if (/^TASK#[^#]+$/.test(item.sk))
    return {
      ...taskTimelineGsi(siteId, item.createdAt, item.taskId),
      ...taskWorklistDateGsi(
        siteId,
        item.status,
        item.kind,
        item.severity,
        item.createdAt,
        item.taskId,
      ),
    };
  if (/^TASK#.+#UPDATE#/.test(item.sk))
    return taskUpdateTimelineGsi(siteId, item.occurredAt, item.updateId);
  return {};
}

/**
 * The header's evidence counts, as checks.js evidenceSummary records them.
 * @param {string[]} kinds "photo" or "text" per artifact
 * @returns {{ photoCount: number, textCount: number, evidenceKind: string }}
 */
function evidenceSummary(kinds) {
  const photoCount = kinds.filter((k) => k === "photo").length;
  const textCount = kinds.length - photoCount;
  return {
    photoCount,
    textCount,
    evidenceKind:
      photoCount && textCount ? "mixed" : textCount ? "description" : "photos",
  };
}
