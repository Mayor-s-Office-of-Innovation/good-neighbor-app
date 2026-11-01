import { faq } from "./faq.js";
import { policy } from "./policy.js";

// Only public, reviewed behavior belongs here. Internal provenance lives in
// knowledge-provenance.json, which is never imported into the Lambda bundle.
export const guide = [
  {
    id: "GUIDE-01",
    title: "Saving a perimeter description",
    text: "A perimeter description must contain at least 20 characters after surrounding spaces are removed. One saved description is an alternative to the photo requirement. Three photos are recommended for coverage; one photo is sufficient to enable completion. This is separate from how many checks your Site should carry out each day: ask your compliance manager about that requirement.",
  },
  {
    id: "GUIDE-02",
    title: "Finding help and other actions",
    text: "The three-dot menu beside the perimeter-check button contains Flag a single issue, public complaints, and proactive care work, in that order. The top-right Settings menu contains Get help, language and feedback options. The app release version appears below Logout, beneath a divider at the bottom of Settings. Local and non-release builds show dev instead of a release version. Get help opens a full-screen view; the circle-X close button returns to the previous screen, or Home if Help was opened directly. Help answers general questions using the FAQ, app guide and supplied Good Neighbor Policy. It cannot view your records, determine your ticket status, enroll a device, or perform actions. Each question needs at least 20 characters after surrounding spaces are removed. Ask stays disabled until that minimum is met. Each question is independent. Leaving Help clears its responses. Email goodneighbor@sf.gov for personal assistance.",
  },
];

export const KNOWLEDGE_VERSION = "faq-v2-policy-2026-11-01-question-minimum";
export const sources = [...faq, ...guide, ...policy];
export const sourceById = new Map(sources.map((entry) => [entry.id, entry]));
