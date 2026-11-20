# Compliance dashboard sign-in: MFA code screen redesign

Design notes from Maanasa (service design). The Cognito-hosted MFA prompt
currently reads "Please enter the code from maanasa." — the sentence
interpolates the TOTP device's friendly name, which users set to their own
name because the setup page's "Device name" field gives no guidance. The
screen gives no context (what code, from where, what format) and no recovery
path for a lost or replaced phone.

Target design (interactive prototype, approved):
<https://claude.ai/artifact/HVfUfaGrSjdR5LVmg4uURK>

- One line of copy: "Enter the code from your authenticator app" as the
  heading. No separate instructions.
- Six code slots show the format; nothing says "6-digit". Behind the slots is
  a single input (`inputmode="numeric"`, `autocomplete="one-time-code"`) so
  paste, backspace, and OS code autofill work natively.
- Sign in stays disabled until the sixth digit.
- Code rotation is explained only in the error state: "That code didn't work.
  Try the newest one from your app."
- Lost-device path is a quiet disclosure: "Can't access your app?" → "Ask
  your administrator to reset your sign-in."

## Shipped in this branch (no behavior change)

- `infra/modules/app/cognito-hosted-ui.css`: submit button and input focus
  moved from neutral grey to the brand blue (#2a60af, hover #234f91). Classic
  hosted UI accepts only its documented CSS vocabulary, so this is the limit
  of what styling alone can do. Applies via the normal Terraform pipeline on
  merge.

## For engineering (not in this branch)

1. **Device name** — the only copy lever on the hosted page. Cognito's
   template is fixed; the friendly device name is the variable. If the device
   is named `your authenticator app` at TOTP enrollment
   (`VerifySoftwareToken` → `FriendlyDeviceName`), the hosted sentence reads
   "Please enter the code from your authenticator app." Options:
   - Set it programmatically wherever admin MFA enrollment is provisioned.
   - Short of that, admin onboarding instructions should tell new users what
     to type in the "Device name" field. Existing users pick it up by
     re-enrolling MFA.
2. **App-owned MFA screen** (the prototype) — replace the hosted redirect
   with Cognito auth-API calls (`InitiateAuth` → `SOFTWARE_TOKEN_MFA`
   challenge → `RespondToAuthChallenge`) so the admin frontend renders its
   own code screen. This also creates the home for the error copy and the
   recovery link.
3. **Reset path owner** — "Ask your administrator to reset your sign-in"
   needs a real procedure (who can run `AdminSetUserMFAPreference` /
   reset the software token, and how users reach them). Today there is none.

## Open questions

- Who owns admin MFA resets operationally (TIS? Aaron)?
- Should the dev and prod pools both get the device-name convention, and is
  there any enrollment automation today that sets `FriendlyDeviceName`?
