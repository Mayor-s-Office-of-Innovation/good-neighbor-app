// Types shared across admin-frontend/src, so pages/ files never import admin-app.js for them.

/**
 * @typedef {ReturnType<typeof import("./config.js").getAdminConfig>} AdminConfig
 * @typedef {{ providerId: string, name: string, sites?: AdminSiteMembership[] }} AdminProvider
 * @typedef {{ siteId: string, deliberate311ProductionEnabled?: boolean, complianceManagerIds?: string[], siteName?: string, name?: string, siteType?: string, address?: string, addressParts?: Record<string, string>, contactPerson?: Record<string, string>, primaryContact?: Record<string, string>, oversight?: Record<string, string>, compliance?: Record<string, string | number | boolean>, perimeter?: string, perimeterUpdatedAt?: string, perimeterUpdatedBy?: string, complianceLetters?: { current?: Record<string, string> | null, past?: Record<string, string>[] }, letterState?: string, geocodedAddress?: string, location?: { latitude?: number, longitude?: number }, sk?: string, providerId?: string, providerName?: string, leadProgramId?: string, programName?: string, primaryContactUserId?: string, status?: string, updatedAt?: string }} AdminSite
 * @typedef {{ siteId: string, siteName: string, status?: string }} AdminSiteMembership
 * @typedef {{ deviceId: string, label?: string, status?: string }} AdminDevice
 * @typedef {{ code: string, issuedTo: string, expiresAt: string }} AdminIssuedCode
 * @typedef {object} AdminOwnState
 * @property {ReturnType<typeof import("./pages/directory/site-311-batch.js").create311Batch>} [site311Batch]
 * @property {any[]} [people]
 * @property {any | null} siteManager
 * @property {boolean} [managerSearchFailed]
 * @property {AdminProvider | null} provider
 * @property {Record<string, string>} [providerManagerGrantErrors]
 * @property {any[]} providerManagerGrants
 * @property {AdminSite | null} site
 * @property {any[]} assignedUsers
 * @property {any[]} assignedComplianceManagers
 * @property {any[]} availableSiteUsers
 * @property {boolean} letterEmailUncertain
 * @property {string | null} [expandedLettersSiteId]
 * @property {string | null} [expandedTermsSiteId]
 * @property {any[]} letterEmailHistory
 * @property {any[]} siteTerms
 * @property {any[]} managerMemberships
 * @property {any[]} managerGrants
 * @property {AdminDevice[]} devices
 * @property {AdminIssuedCode | null} issuedCode
 * @property {string} siteSaveMessage
 * @property {string} siteSaveError
 * @property {boolean} siteSaving
 * @property {string} error
 * @property {boolean} hasToken
 * @property {AdminConfig} authConfig
 * @property {boolean} authBusy
 * @property {ReturnType<typeof import("./compliance-profile-draft.js").captureComplianceDraft> | null} complianceProfileDraft
 * @property {boolean} [siteCanEdit]
 * @property {boolean} perimeterSaving
 * @property {string} perimeterMessage
 * @property {string} perimeterError
 * @property {string} revocationMessage
 * @property {any | null} managerMembershipRemovalTarget
 */

/**
 * Read-only on `state`: only admin-session.js and admin-catalog.js change these.
 * @typedef {object} AdminSharedState
 * @property {AdminProvider[]} providers
 * @property {AdminSite[]} sites
 * @property {any[]} programs
 * @property {any[]} programManagers
 * @property {any[]} siteManagers
 * @property {boolean} managerDirectoryLoaded
 * @property {{ departments: any[], systemsOfCare: any[] }} oversightOptions
 * @property {any | null} profile
 * @property {string} role
 * @property {Record<string, boolean>} capabilities
 */

/**
 * @typedef {AdminOwnState & Readonly<AdminSharedState>} AdminState
 */

export {};
