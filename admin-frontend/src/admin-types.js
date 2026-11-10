// Types shared by main.js and the files in pages/, so pages/ files never import main.js.

/**
 * @typedef {ReturnType<typeof import("./config.js").getAdminConfig>} AdminConfig
 * @typedef {{ providerId: string, name: string, sites?: AdminSiteMembership[] }} AdminProvider
 * @typedef {{ siteId: string, deliberate311ProductionEnabled?: boolean, complianceManagerIds?: string[], siteName?: string, name?: string, siteType?: string, address?: string, addressParts?: Record<string, string>, contactPerson?: Record<string, string>, primaryContact?: Record<string, string>, oversight?: Record<string, string>, compliance?: Record<string, string | number | boolean>, perimeter?: string, perimeterUpdatedAt?: string, perimeterUpdatedBy?: string, complianceLetters?: { current?: Record<string, string> | null, past?: Record<string, string>[] }, letterState?: string, geocodedAddress?: string, location?: { latitude?: number, longitude?: number }, sk?: string, providerId?: string, providerName?: string, leadProgramId?: string, programName?: string, primaryContactUserId?: string, status?: string, updatedAt?: string }} AdminSite
 * @typedef {{ siteId: string, siteName: string, status?: string }} AdminSiteMembership
 * @typedef {{ deviceId: string, label?: string, status?: string }} AdminDevice
 * @typedef {{ code: string, issuedTo: string, expiresAt: string }} AdminIssuedCode
 * @typedef {object} AdminState
 * @property {ReturnType<typeof import("./pages/directory/site-311-batch.js").create311Batch>} [site311Batch]
 * @property {AdminProvider[]} providers
 * @property {AdminSite[]} sites
 * @property {any[]} programs
 * @property {any[]} programManagers
 * @property {any[]} adminUsers
 * @property {string} adminUserStatusFilter
 * @property {string} adminUserMessage
 * @property {string} adminUserDirectoryMode
 * @property {any[]} [people]
 * @property {any[]} siteManagers
 * @property {any | null} siteManager
 * @property {boolean} managerSearchFailed
 * @property {boolean} managerDirectoryLoaded
 * @property {{ departments: any[], systemsOfCare: any[] }} oversightOptions
 * @property {any | null} program
 * @property {AdminProvider | null} provider
 * @property {any[]} [providerManagerDirectory]
 * @property {any[]} providerManagers
 * @property {Record<string, string>} [providerManagerGrantErrors]
 * @property {any[]} providerManagerGrants
 * @property {any[]} providerManagerEnrollments
 * @property {AdminSite | null} site
 * @property {any[]} assignedUsers
 * @property {any[]} assignedComplianceManagers
 * @property {any[]} availableSiteUsers
 * @property {any[]} newSiteUsers
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
 * @property {any | null} profile
 * @property {string} profileMessage
 * @property {string} role
 * @property {boolean} [siteCanEdit]
 * @property {Record<string, boolean>} capabilities
 * @property {any | null} importPreview
 * @property {any | null} importResult
 * @property {boolean} importBusy
 * @property {string} importApplyKey
 * @property {any[]} importHistory
 * @property {{ title: string, message: string } | null} importNotice
 * @property {boolean} perimeterSaving
 * @property {string} perimeterMessage
 * @property {string} perimeterError
 * @property {string} revocationMessage
 * @property {any | null} physicalDeviceRevocationPreview
 * @property {any[]} emergencyRevocationSites
 * @property {any | null} emergencyRevocationPreview
 * @property {any | null} suspensionTarget
 * @property {any | null} managerMembershipRemovalTarget
 */

/**
 * Keeps only an object literal's real keys, so an editor flags a misspelled
 * app.method(). No npm script type-checks admin-frontend yet.
 * @template T
 * @typedef {{ [K in keyof T]: T[K] }} Closed
 */

/**
 * @typedef {Closed<typeof import("./pages/admin-user/admin-user.actions.js").adminUserActions>
 *   & Closed<typeof import("./pages/site/manager.actions.js").siteManagerActions>
 *   & Closed<typeof import("./pages/site/new.actions.js").newSiteActions>
 *   & Closed<typeof import("./pages/site/import.actions.js").siteImportActions>
 *   & Closed<typeof import("./pages/provider/provider.actions.js").providerActions>
 *   & Closed<typeof import("./pages/program/program.actions.js").programActions>
 *   & Closed<typeof import("./pages/site/oversight.actions.js").siteOversightActions>
 *   & Closed<typeof import("./pages/site/record.actions.js").siteRecordActions>
 *   & Closed<typeof import("./pages/site/compliance.actions.js").siteComplianceActions>
 *   & Closed<typeof import("./pages/site/access.actions.js").siteAccessActions>
 *   & Closed<typeof import("./pages/directory/directory.actions.js").directoryActions>} AdminActions
 * @typedef {object} AdminShell
 * @property {AdminState} state
 * @property {(loading?: boolean) => void} render
 * @property {() => Promise<void>} openRoute
 * @property {{ schedule: () => void, cancel: () => void }} [directorySearchDebounce]
 * @property {() => void} [managerSearchCleanup]
 * @property {string | null} [letterResendPending]
 * @property {number} [managerDirectoryVersion]
 * @property {boolean} [programManagersStale]
 * @property {string} [pendingSiteDestination]
 * @property {string} [lastRenderedPath]
 * @typedef {HTMLElement & AdminShell & AdminActions} AdminAppElement
 */

export {};
