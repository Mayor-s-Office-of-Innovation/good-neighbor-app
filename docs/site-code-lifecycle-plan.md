# Site Code Lifecycle Plan

*Planning note · [index](./README.md) · related: [ADR 0010](./adr/0010-device-token-auth.md)*

## Goal

Replace the fixed public set of provider site codes with a lightweight lifecycle for issuing,
expiring, regenerating, and blocking setup codes while preserving the core product constraint:
site staff should not need full user accounts to perform perimeter checks.

The code remains a bootstrap secret for binding a new site device. Once a device is bound, the
existing device-token session model keeps daily use simple and avoids depending on a manager being
present for routine work.

## Constraints

- Provider users should not need full authentication to use the field app.
- New device onboarding should be easy enough to do on site.
- A site must not be stranded when one master admin is unavailable.
- Static public codes must be removable, revocable, and replaceable.
- Provider-facing UI should stay focused on setup and daily checks, not central administration.
- Central support and program administration need a separate operational interface.
- Central admins need to manage providers, sites under providers, and master contacts for each
  site.

## Recommended Approach

Use short-lived, server-generated setup codes with a request-by-email flow for approved provider
contacts, plus a separate central support console for operational recovery.

Setup codes should be:

- Randomly generated server-side.
- Six uppercase alphanumeric characters, preserving the existing code-entry UX.
- Stored hashed or HMACed, not in plaintext.
- Expirable, with a default lifetime of 72 hours.
- Valid for up to three device bindings.
- Revocable by central support.
- Rate-limited on request and verification paths.
- Audited when issued, used, expired, or revoked.

## Provider-Facing UI

### First-Run Code Screen

Keep the existing first-run setup screen centered on entering a setup code.

Add a secondary path:

- `Need a new code?`
- Site search.
- Work email.
- Submit.

Do not ask for an optional reason. The provider user should not have to classify their own recovery
case.

After submit, always show a generic confirmation:

> If that email is authorized for this site, we will send a new setup code.

This avoids revealing whether a site/contact pairing exists.

### Email Code Entry

The email should include:

- Site name.
- Setup code.
- Expiration time.
- `Open Good Neighbor` button.
- Plain fallback URL.
- Reminder to enter the code only on a trusted site device.

The button can open the provider app, but the code itself should still be visible and usable by
typing or pasting. Do not make the email link the only usable credential.

### Existing Device Settings

Skip existing-device settings for now.

Bound devices should keep renewing silently through the device-token flow. Device management,
device revocation, and broader site administration can remain out of the provider-facing app until
there is a concrete need.

## Request-By-Email Flow

1. User selects `Need a new code?` from the first-run setup screen.
2. User searches/selects their site and enters their work email.
3. Backend returns the same generic response for all submissions.
4. Backend checks whether the email is an approved code contact for that site.
5. If authorized, backend invalidates any existing pending setup code for the same site/contact,
   then generates a new setup code.
6. Backend stores only a secure verifier for the code, plus expiration, status, use limit, and audit
   metadata.
7. Backend sends the setup email to the approved contact.
8. Contact opens Good Neighbor from the email or navigates to the app manually.
9. Contact enters the setup code on the new site device.
10. Device registration validates the setup code, binds the device to the code's server-side site,
    mints the normal device-token session, and marks the code used or decrements its remaining uses.

No `siteId` should be accepted from the client as the authority for device binding. The code lookup
continues to determine the site server-side.

## Central Support Console

The central support/program admin console should live outside the provider app, on a separate admin
origin such as:

```text
admin.goodneighborsf.org
```

This admin UI should have no link from the provider-facing app. It serves central support and
program administrators, not site staff doing checks.

Recommended boundary:

- `app.goodneighborsf.org` or `goodneighborsf.org`: provider/shared-device field app.
- `admin.goodneighborsf.org`: central support/program admin console.
- Cognito managed login for admin sign-in; no custom username/password UI in the admin app.
- Separate Cognito app client and central-admin group.
- Authorization-code OAuth flow with PKCE for the browser admin app.
- MFA required for central admins.
- Admin-only API routes, for example `/admin/v1/sites`, `/admin/v1/site-codes`, and
  `/admin/v1/devices`.
- Separate CloudFront distribution for the admin app.

Use a separate distribution for the admin console rather than a path or behavior on the provider
distribution. The two surfaces have different audiences, authentication posture, cache behavior,
WAF tuning, operational risk, and incident response needs. A separate distribution keeps the admin
surface isolated while still letting both apps share backend services where appropriate.

### Admin Console MVP

The first admin console can be deliberately plain:

- Provider search.
- Provider detail.
- Add provider.
- Remove/deactivate provider.
- Site search.
- Site detail.
- Add site under provider.
- Remove/deactivate site.
- Master contacts for each site.
- Add, remove, and change site master contacts.
- Approved code contacts.
- Pending and recently used setup codes.
- Issue new setup code.
- Revoke setup code.
- Active devices.
- Revoke device.
- Audit log.

Central support can use this console as the availability backstop when approved site contacts are
unavailable or when an incident requires revoking codes/devices.

## Data Model Sketch

Add site-scoped items to the existing single-table model:

| Entity | `pk` | `sk` | Notes |
|---|---|---|---|
| Provider | `PROVIDER#<providerId>` | `#META` | provider name, status, created/updated audit fields |
| Provider site membership | `PROVIDER#<providerId>` | `SITE#<siteId>` | site display fields and status for provider-level listing |
| Code contact | `SITE#<siteId>` | `CODE_CONTACT#<emailHash>` | approved contact email, status, created/updated audit fields |
| Master contact | `SITE#<siteId>` | `MASTER_CONTACT#<emailHash>` | site master contact email/name/status, managed by central admins |
| Setup code | `SITE#<siteId>` | `SETUP_CODE#<codeId>` | hashed verifier, status, expiresAt, maxUses, uses, issuedTo, issuedBy, audit fields |
| Device | `SITE#<siteId>` | `DEVICE#<deviceId>` | existing device item; revocation remains generation bump or delete |

Site metadata remains at `pk = SITE#<siteId>`, `sk = #META`. It should include `providerId`,
`providerName`, and `status` so site reads do not need a second provider lookup.

For MVP, "remove" should mean deactivate/retire with audit metadata rather than hard-delete. This
preserves code/device/audit history and avoids orphaning historical check records.

If request lookup needs to find the site/contact pair without scanning, either:

- require the user to select a site before entering email and do a direct site-partition lookup, or
- add a contact lookup item/index keyed by normalized email.

For the provider flow, prefer site search first because it keeps the lookup explicit and avoids a
global email-to-site dependency for the initial version.

## Detailed Implementation Plan

Build this in phases so the provider app can adopt dynamic setup codes before the full admin
console is polished.

### Phase 1: Code Model and Verification

1. Add a backend module for setup-code lifecycle logic, for example
   `backend/src/handlers/setup-codes.js` or `backend/src/site-codes/lifecycle.js`.
2. Keep `normalizeSiteCode()` compatible with typed or pasted codes by stripping separators and
   uppercasing.
3. Replace the current fixed `SITE_CODE#<code>` plaintext lookup with a generated-code model:
   - Generate exactly six uppercase alphanumeric characters.
   - Store a random `codeId`.
   - Store only a secure verifier, such as an HMAC or keyed hash of the normalized code.
   - Store `status`, `expiresAt`, `maxUses: 3`, `uses`, `siteId`, `siteName`, `issuedTo`,
     `issuedBy`, `createdAt`, and `updatedAt`.
4. Implement code validation as a single reusable backend function used by both `/site-code` and
   `POST /v1/devices`.
5. Enforce validation rules:
   - code exists and verifier matches;
   - `status === "pending"`;
   - `expiresAt` is in the future;
   - `uses < maxUses`;
   - site metadata is still present and active.
6. Update device registration to atomically consume one binding use when registration succeeds.
   The registration write and setup-code use increment should be in one `TransactWrite` where
   possible.
7. Return `invalid_site_code` for expired, revoked, exhausted, or unknown codes. Do not disclose
   which condition failed to the provider client.
8. Add unit tests covering valid code, expired code, revoked code, exhausted three-use code, unknown
   code, malformed code, and concurrent consumption at the third use.

Likely files:

- `backend/src/handlers/site-code.js`
- `backend/src/handlers/devices.js`
- `backend/src/handlers/site-code.test.js`
- `backend/src/handlers/devices.test.js`
- `backend/src/config.js`

### Phase 2: Approved Contacts and Email Requests

1. Add code-contact records under each site partition:
   `pk = SITE#<siteId>`, `sk = CODE_CONTACT#<emailHash>`.
2. Add a provider-facing request endpoint, for example
   `POST /v1/setup-codes:request`.
3. The request body should contain only:
   - selected `siteId` or provider site id from site search;
   - work email.
4. Normalize emails consistently:
   - trim;
   - lowercase domain;
   - lowercase the full email unless a stricter city/provider convention says otherwise.
5. Return the same generic 202 response for every syntactically valid request:
   `If that email is authorized for this site, we will send a new setup code.`
6. For authorized contacts:
   - invalidate any existing pending setup code for the same site/contact;
   - generate and store a new setup code;
   - send the setup email.
7. For unauthorized contacts, do not send an email and do not reveal authorization status.
8. Add a site-search endpoint for the first-run request form if one does not already exist, for
   example `GET /v1/sites:search?q=...`. Return only public-safe fields needed to disambiguate
   sites, such as display name and neighborhood/address fragment.
9. Add request throttling at the application layer for site/contact pairs, and rely on WAF/API
   Gateway limits for broad anonymous abuse controls.
10. Add unit tests for generic responses, authorized contact issuance, unauthorized no-op,
    invalidation of prior pending codes, email normalization, and site-search result limits.

Likely files:

- `backend/src/lambda/api.js`
- `backend/scripts/local-api.mjs`
- `infra/modules/app/api.tf`
- `infra/modules/app/main.tf`
- `backend/src/handlers/setup-code-requests.js`
- `backend/src/handlers/setup-code-requests.test.js`

### Phase 3: Email Delivery

1. Choose the email provider already preferred for the deployment environment. If none exists,
   use AWS SES because the app is already on AWS.
2. Add email sender configuration:
   - verified sender/domain;
   - provider app URL;
   - support reply-to address;
   - environment-specific subject prefix for non-prod.
3. Implement an email module that accepts structured data and renders both text and HTML versions.
4. Email content must include:
   - site name;
   - six-character setup code;
   - expiration time with timezone;
   - `Open Good Neighbor` button;
   - plain fallback URL;
   - trusted-device reminder.
5. Do not put the raw setup code in logs, metrics, thrown errors, or structured audit records.
6. Log delivery attempt metadata without the code: site, contact hash, provider message id, and
   status.
7. In local development, write email payloads to a local sink or test logger that is clearly marked
   as dev-only.
8. Add tests for email rendering, absence of raw-code logging, and dev-sink behavior.

Likely files:

- `backend/src/integrations/email.js`
- `backend/src/integrations/email.test.js`
- `backend/src/config.js`
- `infra/modules/app/iam.tf`
- `infra/modules/app/variables.tf`

### Phase 4: Provider First-Run UI

1. Update `<site-setup>` to support two states:
   - enter setup code;
   - request a new setup code.
2. Keep the code-entry path as the default first screen.
3. Add a `Need a new code?` control that reveals the request form without routing away.
4. Build the request form with:
   - site search input/results;
   - work email input;
   - submit button.
5. Remove any optional reason field from the design.
6. Use the generic success message after submit regardless of backend authorization.
7. Keep provider copy short and task-focused. Do not mention the central admin console.
8. Preserve the six-character setup-code input limit.
9. Ensure the `Open Good Neighbor` email button can prefill the code if a `code` query parameter is
   included, while still allowing manual entry.
10. Add frontend tests for state switching, site search selection, email validation, generic success
    messaging, code prefill, and failed network state.

Likely files:

- `frontend/src/components/site-setup.js`
- `frontend/src/components/site-setup.templates.js`
- `frontend/src/components/site-setup.test.js`
- `frontend/src/services/onboarding.js`
- `frontend/src/services/onboarding.test.js`
- `frontend/src/styles/app.css`

### Phase 5: Central Admin API

1. Add admin-only routes under `/admin/v1/*`.
2. Require Cognito auth for central admins, with MFA enforced at the identity-provider layer.
3. Add an authorization helper that rejects callers missing the central-admin group/claim.
4. Implement MVP endpoints:
   - search providers;
   - create provider;
   - read provider detail;
   - update provider;
   - deactivate provider;
   - search sites;
   - create site under provider;
   - read site detail;
   - update site;
   - deactivate site;
   - list site master contacts;
   - create/update/deactivate site master contacts;
   - list approved code contacts;
   - create/update/deactivate approved code contacts;
   - list pending and recently used setup codes;
   - issue setup code;
   - revoke setup code;
   - list active devices;
   - revoke device;
   - read audit events.
5. For MVP, approved code contacts are managed only through these central-admin endpoints.
6. Add tests that prove provider/device principals cannot call admin routes.
7. Add audit writes for every provider, site, contact, code, and device management action.

Likely files:

- `backend/src/lambda/api.js`
- `backend/src/lambda/authorizer.js` or a new admin authorizer
- `backend/src/handlers/admin/*.js`
- `backend/src/handlers/admin/*.test.js`
- `infra/modules/app/api.tf`
- `infra/modules/app/iam.tf`
- `infra/modules/app/main.tf`

### Phase 6: Central Admin Frontend

1. Create a separate admin frontend workspace or source entrypoint. Keep it separate from the
   provider SPA so it can deploy independently.
2. Build the MVP screens:
   - Cognito managed-login handoff and OAuth callback state;
   - provider search;
   - provider detail;
   - provider create/edit;
   - site search;
   - site detail;
   - site create/edit under provider;
   - site master contacts;
   - approved contacts;
   - setup codes;
   - devices;
   - audit log.
3. Keep the UI dense and operational. This is a support console, not a landing page.
4. Use web components and existing frontend patterns where practical.
5. Use Cognito authorization-code + PKCE. The admin app should build the authorize URL, handle the
   callback code exchange, store the access token for API calls, and send admins to Cognito logout
   on sign-out.
6. Do not implement a custom password form. Cognito owns sign-in, password reset, and MFA prompts.
7. Do not link to this console from the provider app.
8. Add tests for provider/site/contact workflows:
   - add provider;
   - add site under provider;
   - add/change/remove site master contact;
   - deactivate site;
   - deactivate provider;
   - issue code;
   - revoke code;
   - revoke device.

Suggested layout:

```text
admin-frontend/
  index.html
  src/
    main.js
    services/admin-api.js
    components/admin-app.js
    components/provider-search.js
    components/provider-detail.js
    components/site-search.js
    components/site-detail.js
```

### Phase 7: Infrastructure

1. Add `admin.goodneighborsf.org` as a separate CloudFront distribution.
2. Use a separate private S3 bucket or clearly separated admin build artifact bucket.
3. Attach admin-specific security headers and WAF rules.
4. Configure a separate Cognito app client for the admin console:
   - managed-login domain;
   - authorization-code grant;
   - PKCE-compatible public client;
   - callback URL such as `https://admin.goodneighborsf.org/auth/callback`;
   - logout URL such as `https://admin.goodneighborsf.org/`;
   - `openid`, `email`, and `profile` scopes.
5. Add admin DNS and ACM certificate wiring.
6. Add admin CloudFront logs and alarms distinct from the provider app.
7. Add environment variables for:
   - provider app URL;
   - admin app URL;
   - email sender;
   - setup-code verifier secret or secret ARN;
   - setup-code TTL and max uses, if configurable.
   - admin Cognito domain, client id, redirect URI, and logout URI.
8. Keep Terraform plan/apply in CI per project SDLC rules.

Likely files:

- `infra/modules/app/cloudfront.tf`
- `infra/modules/app/main.tf`
- `infra/modules/app/variables.tf`
- `infra/modules/app/outputs.tf`
- `infra/modules/app/iam.tf`
- `.github/workflows/deploy-dev.yml`
- `.github/workflows/deploy-prod.yml`

### Phase 8: Migration and Rollout

1. Keep existing static dev/test codes working in local/dev until dynamic issuance is seeded.
2. Add a seed script for local approved contacts and setup codes.
3. For deployed environments, create central-admin users and initial approved contacts out of band
   or via a one-time controlled script.
4. Backfill site metadata needed by site search before enabling request-by-email.
5. Launch in this order:
   - backend dynamic validation behind existing code entry;
   - provider request-by-email UI;
   - email delivery;
   - central admin API;
   - central admin frontend;
   - static public code removal.
6. Keep a rollback path: central support can issue a known temporary code for a site and revoke it
   after use.

Likely files:

- `backend/scripts/seed-dev-site-codes.mjs`
- `backend/scripts/local-bootstrap.mjs`
- `docs/dev-commands.md`

### Phase 9: Verification Checklist

Before considering the feature complete:

- `npm run lint`
- `npm run typecheck`
- backend unit tests for code lifecycle, request-by-email, devices, admin endpoints, and email
  rendering;
- frontend tests for provider setup and admin workflows;
- local harness confirms a fresh device can bind with a generated code;
- admin console can add a provider, add a site under that provider, and add/change/remove site
  master contacts;
- admin console can deactivate a site and deactivate a provider without deleting historical
  records;
- a fourth binding attempt with the same code fails;
- a newly requested authorized code invalidates the prior pending code for the same site/contact;
- unauthorized email request returns generic success and sends no email;
- revoked device tokens fail authorizer checks;
- raw setup codes do not appear in logs;
- admin routes reject provider device tokens;
- provider app contains no link to `admin.goodneighborsf.org`;
- CloudFront and WAF route provider and admin apps independently.

## Security Controls

- Rate-limit setup-code request and verification routes.
- Treat rate limiting as required because the code remains six characters.
- Use generic responses for request-by-email.
- Avoid logging raw codes.
- Store only hashed/HMACed code verifiers.
- Expire codes automatically after 72 hours.
- Revoke or replace pending codes when central support determines a code is exposed.
- Audit code issuance, delivery attempts, use, expiration, and revocation.
- Keep central admin auth stronger than provider device setup: Cognito plus MFA.

## Implementation Choices

- Setup codes allow up to three device bindings.
- A new authorized request invalidates any existing pending setup code for the same site/contact.
- Approved code contacts are managed only by central admins for MVP.
- The admin console should be hosted as a separate CloudFront distribution.
- Central admins can add and deactivate providers, add and deactivate sites under providers, and
  add/change/deactivate master contacts for each site.
