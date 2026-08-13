# gnp — Live Audio Transcription: Architecture Discussion & Plan

> **Resuming? Read [`transcription-STATUS.md`](./transcription-STATUS.md) first** — it has the
> locked decisions, current progress, and next actions. This doc is the full design/reasoning.

**Date:** 2026-08-06
**Status:** Design complete; gate decided (per-site invite codes). Audio spike built, not yet tested.
**Reference:** care-connect's "Option C" design —
`../../notes/plans/lambda-transcription-client-direct.md` (browser streams mic audio
directly to Amazon Transcribe using short-lived STS creds; audio never touches your compute).

**Decided so far:**

- **UX = live partial results** (text appears as the person speaks), the full Option C experience.
- **Identity model = still deciding** — this doc exists to make that call.

---

## 1. The key reframe: transcription is _not_ a compute service

It's tempting to picture three sibling backend services (sync, photo analysis, transcription).
But they're three _different shapes_, and transcription is the odd one out:

| Concern                            | Shape                                                                 | Does the payload flow through _your_ compute? |
| ---------------------------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| **Sync / data backend** (coming)   | Stateful — owns the DB, device identity, per-site task sync           | Yes (task data)                               |
| **AI photo analysis**              | Stateless compute — photo in, issues out                              | **Yes** — the image is the request body       |
| **Audio transcription (Option C)** | Credential broker — audio goes _browser → Amazon Transcribe directly_ | **No** — audio never touches your infra       |

That's the whole point of Option C: the audio **bypasses Lambda entirely** — dodging the 6 MB
payload cap, function timeouts, and CloudFront origin timeouts — and, with live streaming,
enables partial results. Your server's _only_ job is to hand the browser a short-lived,
single-action AWS credential.

So transcription is **not a service** the way photo-analysis is. It's an
**identity / authorization concern**: _"is this a legitimate site device? → here's a
15-minute `transcribe:StartStreamTranscription` credential."_ The only thing it needs is
**device identity** — which is exactly what the sync backend must establish anyway.

### What that implies

- **Photo analysis** → genuinely a separate stateless service (a Lambda the image POSTs to).
  It can live on its own; it just needs the same gate as everything else.
- **Transcription** → should **ride on whatever identity system the sync backend uses**, not
  be its own service. A standalone "transcription service" would duplicate device-identity
  logic the sync backend will own.

This is why picking a credential mechanism in the abstract is the wrong move — the right
answer is _"the same identity layer the sync backend will use."_

---

## 2. Phasing — transcription can _seed_ the identity layer

You want live transcription now, but the sync backend doesn't exist yet. The convenient part:
transcription only needs the **credential/identity** piece, not the DB or sync logic. So we can
stand up the identity foundation for transcription first and have the sync backend **inherit**
it — the transcription work isn't throwaway; it plants the device-identity layer the backend
needs regardless.

---

## 3. The two Cognitos (why it felt complex before)

People conflate two very different AWS products under "Cognito":

### Cognito **User Pools** — _not_ what we're using

The full user directory: sign-up/sign-in, passwords, MFA, hosted UI, email/SMS verification,
SRP auth flow, token refresh, Lambda triggers. **This is the painful one** everyone remembers.

### Cognito **Identity Pools** ("Federated Identities") — what we'd actually use

A much smaller, dumber thing. Its entire job: **exchange an identity for temporary AWS IAM
credentials via STS.** In _unauthenticated / guest_ mode there is **no login, no passwords, no
user directory at all** — the browser says "give me guest creds" and gets short-lived STS creds
scoped to a role you define. It's closer to a credential vending machine than an auth system.

### What the setup actually is (unauth case)

**One-time infra** (console, CLI, or a small CloudFormation template ~ the size of
care-connect's `../../care-connect/aws/transcribe.json`):

1. Create an Identity Pool, enable "access to unauthenticated identities."
2. It auto-creates two IAM roles (authenticated + unauthenticated). You only touch the
   **unauth role** — attach a policy with exactly one action:
   `transcribe:StartStreamTranscription`.
3. That role's trust policy (the historically-fiddly bit) is **auto-generated** by the create
   flow. You rarely hand-write it.

**Client code** — replaces the entire credential dance. ~3 lines, no login UI:

```js
import { fromCognitoIdentityPool } from "@aws-sdk/credential-providers";
import { TranscribeStreamingClient } from "@aws-sdk/client-transcribe-streaming";

const client = new TranscribeStreamingClient({
  region: "us-west-2",
  credentials: fromCognitoIdentityPool({
    identityPoolId: "us-west-2:xxxx-xxxx-…", // public, safe to embed (like a Firebase config)
    clientConfig: { region: "us-west-2" },
  }),
});
```

The SDK handles getting the guest identity, fetching temp creds, caching, and refreshing them.
No Lambda, no DynamoDB, no token code. **The Identity Pool ID is not a secret** — it's meant to
ship in the client.

### The honest caveat

The flip side of "guest, no login" is that **anyone with that (public) pool ID can get the same
guest creds** — so the gate strength equals the "open Lambda" option: **cost-only blast
radius**, one action, short TTL. That's inherent to _any_ no-auth approach, not a Cognito flaw.
A real gate (revoke a specific device, rate-limit per site) needs server-side validation —
that's the device-token option, or later, real auth.

### Not a dead end

When you add real auth later (SSO), you attach it to the **same** Identity Pool as an identity
provider. Authenticated devices then receive the _authenticated_ role (scope it more broadly),
and you can switch guest access off. Cognito grows into real auth **without a rebuild**.

---

## 4. The real decision: gate strength

Cognito-vs-custom isn't really the question — **how much of a gate you want on cred-vending**
is. Three coherent choices:

| Option                      | Real gate (revoke / rate-limit)? | Server code?      | Effort                                 | Grows into sync backend how                                     |
| --------------------------- | -------------------------------- | ----------------- | -------------------------------------- | --------------------------------------------------------------- |
| **A. Cognito unauth pool**  | No — cost-only risk              | None              | ~3 lines client + 1 small IAM template | Attach SSO/User Pool to same pool later → real gate, no rebuild |
| **B. Open Lambda endpoint** | No — cost-only risk              | A little          | Small Lambda + STS AssumeRole          | Becomes just another route on the sync backend                  |
| **C. Device tokens**        | **Yes**                          | DynamoDB + Lambda | Most                                   | Seeds the sync backend's device registry directly               |

**Recommendation: A (Cognito unauth pool)** for this phase — purpose-built for a
no-auth-yet, device-bound, offline PWA; gives credential vending for free; and becomes real
auth cleanly when SSO arrives. Choose **C** only if you want a revocable per-device gate _now_
and are happy to build the registry (which the sync backend needs eventually anyway).

> **DECISION (2026-08-06): cost-only blast radius rejected.** Options A and B are out. We are
> building a **real gate** — see Section 4b.

---

## 4b. Minimal security (a real gate, no auth yet)

### The chain of consequences

A real gate means the caller must present _something_ the server validates before vending
creds. That something **cannot live in the shipped app bundle** — anything in client JS is
extractable by anyone who loads the page (which is why a hardcoded API key is _not_ a gate). So
it must be **provisioned per-device**, which forces:

**device registration → device registry (DynamoDB) → server-side validation (Lambda).**

This is Direction C. The registry is **the first brick of the sync backend** — the same device
identity that gates transcription will gate the sync API. Not a detour; the backend's identity
layer, started at its smallest useful slice.

### The unavoidable truth

A no-auth web app must **bootstrap device trust from an out-of-band secret or a human step.**
You cannot get a real gate purely from the shipped client. The only genuine decision is _where
that bootstrap step goes:_

| Bootstrap mechanism                                          | How it works                                                                                                                              | Real gate?             | Friction                        | Leak blast radius               |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------- | ------------------------------- |
| **Per-site enrollment code** (recommended)                   | Admin generates a code per site (out-of-band: email/print). Device enters site + code at setup → gets a device token stored in IndexedDB. | **Yes**                | One code per site to distribute | One site; revocable/rotatable   |
| **Admin-approved registration**                              | Device registers → "pending" → admin approves in a console.                                                                               | **Yes** (strongest)    | Highest — a human per device    | None until approved             |
| **Bot-mitigation only** (Turnstile/WAF on open registration) | No secret; just stop bots.                                                                                                                | **No** — probabilistic | Lowest                          | Anyone human can still register |

### Defense in depth (regardless of gate)

The gate decides _who_ gets a token; these bound the damage even if a token leaks:

- **Scoped role** — single action (`transcribe:StartStreamTranscription`), nothing else.
- **Short TTL** on vended creds (STS min 900 s; re-vend per recording).
- **Rate limits** per device/site (API Gateway throttling + usage plans).
- **AWS Budget + CloudWatch alarms** on Transcribe spend → alert / auto-disable.
- Optional **daily per-device minute cap** tracked in the same DynamoDB table.

So a stolen token is bounded to _some cost, on one revocable device, for a short window_ — not
open-internet exposure.

### Recommended minimal design

**Per-site enrollment code → device token → validated vend → scoped short-lived creds**, wrapped
in rate limits + cost alarms. Lightest thing that is a _real_ gate; blast radius is one
revocable site; every piece is reused by the sync backend.

```
SITE PROVISIONING (out-of-band, admin)
  admin generates enrollment code for site  ──▶  stored (hashed) in DynamoDB

DEVICE SETUP (first run, once per device)
  device enters siteId + enrollment code
     │  POST /register  (validates code)
     ▼
  Lambda issues per-device token  ──▶  token (hashed) + siteId in DynamoDB
     │
     ▼
  device stores token in IndexedDB   (NOT in the app bundle)

RECORDING (each session)
  device ──POST /transcribe-credentials (device token)──▶ Lambda
     │  validate token → check rate limit / daily cap
     │  sts:AssumeRole (scoped, single-action, short TTL, optional session policy)
     ▼
  { accessKeyId, secretAccessKey, sessionToken, expiration, region, vocabularyName? }
     │
     ▼
  browser streams PCM directly to Amazon Transcribe   (audio never touches Lambda)
```

### Open bootstrap questions

1. **Which bootstrap mechanism** — enrollment code / admin approval / bot-mitigation.
2. **Provisioning path** — is there an admin/ops route to distribute a code (or approve) across
   ~400 sites? This gates whether enrollment codes are operationally feasible.
3. **Rate-limit + cost-cap defaults** — acceptable per-device/day ceiling; who gets the alarm.

---

## 5. Implementation plan

**DECIDED (2026-08-06):** gate = **per-site invite codes over email**. An admin generates a
code per site and emails it. At the app URL, the site administrator enters the code; we validate
it, register the device, and unlock recording (and future gated features) for that device.

Two workstreams: **(I) the credential/identity backend** (new — first bricks of the sync
backend) and **(II) the client audio-streaming rework** (~90% of the effort). Sequenced to
de-risk the fiddly audio pipeline first.

### 5.0 New backend components (`aws/`, mirroring care-connect's CloudFormation pattern)

- **DynamoDB** (single-table is fine for now):
  - `SITE` — `{ siteId, name, createdAt }`.
  - `INVITE` — `{ codeHash, siteId, expiresAt, maxUses, uses, revoked }`. Codes stored **hashed**;
    reusable across a site's devices up to `maxUses`; expirable + revocable.
  - `DEVICE` — `{ deviceId, siteId, tokenHash, createdAt, revoked, usage:{ date, seconds } }`.
    Device tokens stored **hashed**; plaintext lives only in the device's IndexedDB.
- **Two Lambdas** behind an **API Gateway (HTTP API)** with throttling:
  - `POST /register` — body `{ inviteCode }` → validate (exists, not expired/revoked, uses left)
    → mint a random device token → store `tokenHash` + `siteId`, increment `uses` →
    return `{ siteId, siteName, deviceToken }`.
  - `POST /transcribe-credentials` — body `{ deviceToken }` (or `Authorization` header) →
    validate token (exists, not revoked) → check per-device daily cap / rate limit →
    `sts:AssumeRole` on the scoped role (short TTL, optional session policy) →
    return `{ accessKeyId, secretAccessKey, sessionToken, expiration, region, vocabularyName? }`.
- **IAM:** vend-Lambda execution role may `sts:AssumeRole` the scoped role only; **scoped role**
  = `transcribe:StartStreamTranscription` and nothing else. No static keys anywhere.
- **Admin tooling:** a small **CLI/script** to generate an invite code for a site and print it
  for emailing (no admin UI this phase).
- **Blast-radius limiters:** API Gateway throttling; short STS TTL; per-device daily minute cap
  (tracked in `DEVICE.usage`); **AWS Budget + CloudWatch alarm** on Transcribe spend.

### 5.1 Spike (throwaway) — de-risk the audio pipeline _(do first)_

- Standalone page: `getUserMedia` → **AudioWorklet** → 16 kHz Int16 PCM frames →
  `@aws-sdk/client-transcribe-streaming` with a **manually pasted** temp cred → confirm live
  partial transcripts render.
- Decide **`microphone-stream` vs. hand-rolled AudioWorklet** here (see gotchas §6).
- No app code touched until this works.

### 5.2 Site-setup integration (client)

- `src/components/site-setup.js` first-run flow becomes: **enter invite code** → `POST /register`
  → on success store `{ siteId, name, deviceToken }` in IndexedDB → device bound + record-enabled.
- First-run registration **requires network** (reasonable); the app works offline afterward
  (transcription itself always needs network — see §6.4).
- The invite code maps to a site server-side, so the manager no longer picks a site separately —
  the code _is_ the binding.

### 5.3 Client: real streaming component

- Rework `src/components/capture-audio.js`: keep `getUserMedia` and the 180 s cap + warning
  thresholds; **replace** the `MediaRecorder`-to-Blob path with a live PCM stream feeding
  `StartStreamTranscriptionCommand` (`LanguageCode: 'en-US'`, `MediaEncoding: 'pcm'`,
  `MediaSampleRateHertz: 16000`, optional `VocabularyName`).
- Creds come from `POST /transcribe-credentials` using the stored `deviceToken`; vend per
  recording session (short TTL ≫ 180 s max recording).
- Reuse care-connect's `downsampleToInt16` logic
  (`../../care-connect/client/src/components/AudioRecorder.jsx`), per-frame instead of on a buffer.
- **Lazy-load** `@aws-sdk/client-transcribe-streaming` so it's not in the initial PWA bundle.
- Live UI state: connecting / listening / partial-text / final / error (mic denied, no speech,
  mid-stream drop, cred-vend failure, not-registered).

### 5.4 Wire into the form

- `src/services/transcribe.js` is currently a mock with a clean swap point (`Blob → string`).
  With **live** transcription the contract shifts from "Blob in, string out on submit" to
  "final text streamed into the Description field as the person speaks." Update
  `report-form.js` so the transcript populates the `#desc` field live (finals appended), rather
  than being computed on submit.
- Keep the mock as a fallback when offline / Transcribe unreachable (photo + text capture must
  still work offline).

### 5.5 Custom vocabulary (optional, later)

- care-connect used a custom vocabulary for domain terms. gnp's rubric has domain words
  (encampment, feces, biohazard, needle, etc.) worth adding. Defer; the cred payload already
  carries optional `VocabularyName` so it's a config flip.

### 5.6 Verify on the real device/browser matrix

- AudioWorklet + `getUserMedia` need a secure context (HTTPS/localhost) and a modern browser.
  Confirm against the actual 400-site hardware before relying on it in the field.

---

## 6. Gotchas carried over from Option C

1. **AudioWorklet plumbing is the bulk of the work** — raw PCM frames (not `MediaRecorder`
   blobs), per-frame downsample, async-iterable feed to the SDK. `microphone-stream` reduces
   this; evaluate in the spike.
2. **Bundle size** — the streaming SDK is heavy; lazy-load/code-split it out of the initial PWA
   precache so offline photo+text capture stays lean.
3. **Temp creds live in the browser** — scoped to one action, short TTL; re-vend per recording
   session rather than caching long-term.
4. **PWA/offline** — transcription needs network; don't service-worker-cache the stream. Keep a
   graceful "transcription unavailable offline" path (text/photo capture still works).
5. **Error paths** — mic permission denied, empty/no-speech transcript, mid-stream network
   drop, cred-vend failure. Live streaming needs richer state than the current spinner.
6. **Browser support** — confirm AudioWorklet on the real field devices.

---

## 7. Open decisions

- ~~**Gate strength**~~ — **RESOLVED:** per-site invite codes over email (§4b, §5).
- ~~**Cognito vs custom**~~ — **RESOLVED:** custom device-token backend (Direction C).

Remaining (defaults proposed; confirm or adjust):

1. **Invite-code lifecycle** — _proposed:_ reusable per site up to `maxUses`, 90-day expiry,
   revocable. (Alternative: single-use, one code per device.)
2. **Rate-limit / daily cap** — _proposed:_ per-device cap ~60 transcription minutes/day + API
   Gateway throttling; CloudWatch/Budget alarm → a named ops email.
3. **`microphone-stream` vs. hand-rolled worklet** — decide in the spike (5.1).
4. **Custom vocabulary** — include domain terms now or defer (5.5). _Proposed: defer._
5. **Offline fallback** — when offline/Transcribe unreachable: hide the recorder, or keep
   record-to-Blob + deferred transcription as a fallback? _Proposed: keep a Blob fallback._
6. **Device/browser matrix** — what are the 400 sites running? Gates AudioWorklet use.
7. **Backend stack** — Lambda runtime/IaC. _Proposed:_ Node + CloudFormation/SAM under `aws/`,
   mirroring care-connect. (Confirm this is the seed you want the sync backend to grow from.)

```

```
