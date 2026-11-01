# Support chat

Get help opens from the top-right Settings menu as the full-screen `/help` route.
The circle-X close button returns to the preceding screen (or Home on a direct load). It answers
independent questions using the reviewed FAQ v2, the supplied final Good Neighbor Policy, and a small public app guide.
No conversation is stored; leaving Help clears responses and aborts pending requests. The UI keeps at most ten
exchanges in memory and sends only the current question and selected language.
Canonical source entries are shown in English; model answers use the app locale.

## Content and grounding

`backend/src/support/faq.js` contains the 64 approved FAQ v2 entries, identified
by `FAQ-01` through `FAQ-64`. Preserve these IDs when revising an entry; allocate
a new ID for a new question. `knowledge.js` adds reviewed, public-safe behavior
explanations. The Word source's checksum and code evidence are recorded in
`knowledge-provenance.json`; that internal provenance is not imported at runtime.

The product owner's clarifications govern this bundle: one photo or saved
description permits completion (three photos recommended); duplicate detection
is enabled in production; silent informational tickets are excluded from user
help; FAQ retention and data-use statements are approved. Do not confuse photos
per check with checks per day; site-specific daily requirements belong to the
compliance manager. The older architecture and duplicate handoff are stale on
these points and must not override the approved content.

When the provenance check fails, inspect the affected code and its tests, revise
the corresponding FAQ or guide if behavior changed, and update the SHA-256 after
review. Never import raw code, configuration, credentials, internal URLs, private
records, document comments or metadata into the model bundle. The bundle has a
55,000-character ceiling. Run `npm run support:check -w backend` after changes.

System instructions constrain scope and require citations. Server validation
rejects unknown IDs, absent citations, tool outputs, malformed JSON, truncation,
HTML, URLs and excessive answers. Validation cannot prove semantic grounding;
valid source IDs can still accompany unsupported claims. The evaluation and
human review below remain release gates.

`policy.js` contains full text from all 13 pages of
`Good_Neighbor_Policy_FINAL_08.19.2026.pdf`, with page footers removed and
stable `POLICY-01` through `POLICY-13` IDs. Citation titles name the policy,
page, and topics. The original PDF hash is in `knowledge-provenance.json`.
These are reference materials supplied at inference time, not model training.
The 55,000-character budget accommodates the complete policy without dropping
qualifications; this increases per-question input tokens. Review latency and cost
with the expanded bundle before production rollout.

Use policy text for policy requirements and the FAQ for app mechanics. Do not
infer app functionality from a policy requirement or determine an individual
site's compliance. Three checks daily are a best practice; mandatory documented
checks depend on the funding department's written requirements and thresholds.
Page 4 describes app documentation of community concerns as optional, whereas
page 8 requires it: answers must disclose this ambiguity and refer clarification
to the funding department. Other unresolved conflicts use the unknown fallback.

## Runtime and privacy

`POST /v1/support` uses the existing device authorizer and a dedicated Lambda.
The support role has no DynamoDB, S3, account, email, queue or secret-read access.
It can invoke one regional foundation model, inspect Bedrock invocation logging,
decrypt its encrypted environment and emit logs. There are no model tools.

CloudFront injects a generated origin token held in Secrets Manager and the
encrypted Lambda environment. Direct API calls without it are rejected before
inference. The token, device authorization and request context never enter the
prompt. It is persisted once; coordinate secret-version, distribution and Lambda
updates when rotating it so callers do not lose access during propagation.

Before every inference, the service reads regional Bedrock invocation logging
configuration. If text logging is enabled, ambiguous, or unreadable, it fails
closed without sending the question. Do not enable regional text invocation
logging for this service. This check is not atomic with administrative changes:
coordinate logging changes with disabling support first.

Application logs contain only fixed markers, outcome, latency, token counts and
knowledge version. Exceptions and request/response bodies are never logged.
The existing API Gateway access logs contain request metadata, not bodies.
WAF sampled requests are disabled across the field-app ACL because managed-rule
sampling can otherwise retain support bodies. Keep any future WAF logging from
capturing support request data. The UI has no transcript analytics or persistence.

Limits: at least 20 UTF-16 code units after trimming surrounding whitespace and
at most 1,000 UTF-16 code units per question, 8 KiB decoded body, 400 model output
tokens, 1,500 answer characters, three sources, 15-second backend deadline and
20-second UI deadline. Requests contain no history. WAF limits the exact route
to approximately 30 requests per viewer IP per five minutes. API Gateway limits
support to 2 requests/second with burst 5; Lambda reserves 5 executions. Shared
site IPs share the WAF allowance. These limits bound traffic, not a hard dollar
budget. Model and network errors are not automatically retried; an authentication
rejection can refresh the existing app session and retry once before inference.

## Validation and release

1. Run unit tests, type checks, lint, `support:check`, translation checks, frontend
   build and Lambda bundling. Run `npm run test:support:ui` for the isolated
   browser/accessibility suite and the main `support.e2e.spec.js` with the local
   app harness. The isolated suite mocks all model responses.
2. Terraform defaults `enable_support_chat` to false. Enable it in the dev module
   through the normal CI plan/apply workflow. Confirm the configured regional
   model is available and allowed in that account; the initial candidate is
   `amazon.nova-lite-v1:0`. No production model-quality claim is implied by unit
   tests. Model access failures leave the email link available.
3. In the dev account, run `AWS_REGION=<region> SUPPORT_MODEL_ID=<model>
   node backend/scripts/evaluate-support.mjs --live`. It makes 90 synthetic
   requests across all five languages and prints only synthetic evaluations.
   Review every answer for factual support, appropriate refusals, clear language,
   preserved exceptions and no claims of actions. Test direct-origin rejection
   and WAF limiting in dev. Check observed latency and token usage.
4. Enable production only after that evaluation and normal release review. To
   disable answers, set `enable_support_chat = false` via CI. Help and the fixed
   email link remain available. Never apply Terraform from a developer laptop.

For local manual inference, explicitly set `SUPPORT_ENABLED=true`,
`SUPPORT_MODEL_ID`, `AWS_REGION`, and a nonempty `SUPPORT_ORIGIN_TOKEN` in the local
environment. The local harness injects that header; it does not disable the
privacy check. Tests never require AWS credentials or live inference.

For the local harness, set `SUPPORT_AWS_PROFILE` to an authenticated development
AWS profile. This selects real credentials only for support's Bedrock calls;
keep the dummy `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` values used by the
emulators, and do not set a global `AWS_PROFILE` for the harness. Restart the
backend after changing `.env.local`. Leave `SUPPORT_AWS_PROFILE` unset in Lambda
so it uses its isolated execution role.

## Monitoring

`SupportResponse` records outcome, latency and token counts. `SupportUnavailable`
counts failures without exposing their messages. CloudWatch aggregates input and
output tokens and alarms on repeated unavailability or Lambda throttles. Inspect
model permissions, regional logging configuration and quotas when unavailable;
do not enable transcript logging to troubleshoot. Review shared-IP false positives
before changing the rate limit. Email support remains the handoff for every failure.

## Origin token rotation

The origin token is copied into CloudFront's origin header and the support
Lambda's environment by Terraform. Rotating only the Secrets Manager value
would leave both consumers using the old token, so automatic standalone secret
rotation is not configured (`CKV2_AWS_57` exception). Rotation is coordinated by
an operator through the CI Terraform deployment workflow:

1. Disable support answers with `enable_support_chat = false` and deploy.
2. Request replacement of `module.app.aws_secretsmanager_secret_version.support_origin`
   in the CI plan/apply run. This generates a new token and updates both consumers;
   `ignore_changes` otherwise intentionally keeps the existing token stable.
   Do not print or copy token values into logs, commands, or source files.
3. Wait for the CloudFront distribution to finish deploying and confirm the
   Lambda configuration update has completed before re-enabling support.
4. Re-enable support through CI. Verify an authorized frontend request succeeds
   and a direct request without the origin header is rejected. If propagation
   fails, leave support disabled and complete the coordinated update.

Rotate immediately on suspected exposure, and include this secret in the regular
credential review. The dedicated encryption key has automatic KMS key rotation
and an explicit account-administration policy; runtime support has no access to
read the origin secret from Secrets Manager.

## Signing dependency and local credentials

`@smithy/signature-v4` supplies AWS Signature Version 4 canonicalization and
request signing for direct Bedrock HTTPS calls. Native `fetch` and cryptographic
primitives do not implement that AWS protocol. Using AWS's maintained signer
avoids maintaining a custom signing implementation; hashing still uses Node's
native crypto. The package was already present transitively and is declared as
a direct dependency because support imports it directly.

The installed AWS SDK's `defaultProvider({ profile })` skips environment
credentials when an explicit profile is supplied. Support uses that option for
`SUPPORT_AWS_PROFILE`, leaving the emulator credentials unchanged. The offline
credential regression test uses temporary fake profile files and the actual SDK
provider and signer to verify this behavior, including when another global
`AWS_PROFILE` is present. Keep that regression check when updating the SDK.

## Resource tagging coverage

All tag-capable support resources use the seven CCSF tags through `var.tags`.
The installed AWS provider schema does not accept `tags` for
`aws_apigatewayv2_integration`, `aws_apigatewayv2_route`, `aws_lambda_permission`,
or `aws_cloudwatch_log_metric_filter`. Adding that argument would fail Terraform
validation. These child resources are associated with the tagged HTTP API,
support Lambda, or support log group; the metric alarms are separately tagged.
Record this provider limitation in resource-inventory reviews rather than
claiming those child objects are directly tagged. This documents technical
coverage, not a separate compliance approval.
