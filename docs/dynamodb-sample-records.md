# DynamoDB Sample Records

*Companion to [dynamodb-data-model.md](./dynamodb-data-model.md) · [index](../README.md)*

**Date:** 2026-10-01. Shapes taken from the handlers, the worker, and the analyzer fixtures
on that date. If a field here disagrees with the code, the code wins. Please update this
file when you change an item shape.

## What this shows

One perimeter check at one site, followed all the way through:

1. Staff take one photo. That creates a **check header** and one **artifact**.
2. The worker sends the photo to the analyzer and stores one **analysis**.
3. On complete, the worker writes the scorecard onto the **check header**.
4. The guidance step turns the analysis into an **assessment** with one **condition** per
   concern.
5. The rule for that condition creates one **task**.

All six items share the same partition key, `SITE#bayview-haven`. The values are made up
but have the real shape. Long text is trimmed.

IDs used throughout:

| Name | Value |
|---|---|
| `siteId` | `bayview-haven` |
| `checkId` | `0d6d1a4e-8f1c-4a4b-9c2a-5e7e2c6b1f10` |
| `artifactId` | `7b2f9c3e-1d44-4e0b-a6a1-3f1c9d8e2b77` |
| `assessmentId` | `c1a7e2d4-55b3-4f0e-8a9d-2b6c7d8e9f01` |
| `conditionId` | `001-feces-and-urine` |
| `taskId` | `4f8e2b1c-9a3d-4c7e-b2f5-6d1a8c9e0b23` |

## How the items sit in the table

DynamoDB sorts items with the same `pk` by `sk`. Here are the six items in that order.
Note that a check's header, analysis, and artifact sit together because they share the
`CHECK#<checkId>` prefix. That is what makes the check detail screen one query.

| `pk` | `sk` | Item |
|---|---|---|
| `SITE#bayview-haven` | `ASSESSMENT#c1a7e2d4-…` | assessment |
| `SITE#bayview-haven` | `ASSESSMENT#c1a7e2d4-…#COND#001-feces-and-urine` | condition |
| `SITE#bayview-haven` | `CHECK#0d6d1a4e-…` | check header |
| `SITE#bayview-haven` | `CHECK#0d6d1a4e-…#ANALYSIS#7b2f9c3e-…` | analysis |
| `SITE#bayview-haven` | `CHECK#0d6d1a4e-…#ART#7b2f9c3e-…` | artifact |
| `SITE#bayview-haven` | `TASK#4f8e2b1c-…` | task |

The `gsi1pk` … `gsi5sk` fields below are what put an item into a GSI. Items without those
fields are simply not in that index.

## 1. Check header

Written by `createCheck` when staff start a check. The worker bumps `issueCount` and
`maxSeverity` as each analysis lands. `completeCheck` adds everything from `grade` down.
`gsi1pk` and `gsi1sk` put the header in the GSI1 checks timeline.

```json
{
  "pk": "SITE#bayview-haven",
  "sk": "CHECK#0d6d1a4e-8f1c-4a4b-9c2a-5e7e2c6b1f10",
  "gsi1pk": "SITE#bayview-haven",
  "gsi1sk": "2026-09-30T15:02:11.000Z",
  "checkId": "0d6d1a4e-8f1c-4a4b-9c2a-5e7e2c6b1f10",
  "status": "completed",
  "flowType": "perimeter",
  "startedAt": "2026-09-30T15:02:11.000Z",
  "issueCount": 2,
  "maxSeverity": 3,

  "grade": "Poor",
  "summary": "The perimeter has significant concerns that need attention: a pile of feces outside the front door; cans and paper scattered near the planter.",
  "categories": [
    {
      "category": "Feces and urine",
      "maxRating": 3,
      "sourceArtifactIds": ["7b2f9c3e-1d44-4e0b-a6a1-3f1c9d8e2b77"]
    },
    {
      "category": "Litter",
      "maxRating": 2,
      "sourceArtifactIds": ["7b2f9c3e-1d44-4e0b-a6a1-3f1c9d8e2b77"]
    }
  ],
  "rubricVersion": "1.0.0",
  "photoCount": 1,
  "textCount": 0,
  "evidenceKind": "photos",
  "synthesizedAt": "2026-09-30T15:06:40.000Z",
  "completedAt": "2026-09-30T15:06:40.000Z"
}
```

Before `complete`, the item has only the fields above the blank line, with
`"status": "in_progress"`.

## 2. Artifact

Written by `registerArtifact` after the client uploads the photo to S3. The item holds the
S3 key, never the photo. For a typed description instead of a photo, the item has `text`
and no `s3Key` or `contentType`.

```json
{
  "pk": "SITE#bayview-haven",
  "sk": "CHECK#0d6d1a4e-8f1c-4a4b-9c2a-5e7e2c6b1f10#ART#7b2f9c3e-1d44-4e0b-a6a1-3f1c9d8e2b77",
  "checkId": "0d6d1a4e-8f1c-4a4b-9c2a-5e7e2c6b1f10",
  "artifactId": "7b2f9c3e-1d44-4e0b-a6a1-3f1c9d8e2b77",
  "s3Key": "checks/bayview-haven/0d6d1a4e-8f1c-4a4b-9c2a-5e7e2c6b1f10/7b2f9c3e-1d44-4e0b-a6a1-3f1c9d8e2b77",
  "contentType": "image/jpeg",
  "capturedAt": "2026-09-30T15:03:27.000Z",
  "latitude": 37.7312,
  "longitude": -122.3826
}
```

A description-only artifact looks like this:

```json
{
  "pk": "SITE#bayview-haven",
  "sk": "CHECK#0d6d1a4e-…#ART#9e1c…",
  "checkId": "0d6d1a4e-…",
  "artifactId": "9e1c…",
  "text": "Pile of feces by the front door. Cans and paper along the planter on the Third Street side.",
  "capturedAt": "2026-09-30T15:04:02.000Z"
}
```

## 3. Analysis

Written by the analyze worker, one per artifact. `concerns[]` is the analyzer's output
after our adapter renames the fields. `evidenceIndices` point into the inputs the analyzer
received for this artifact. The header's `categories` above is the rollup of these
concerns across all artifacts in the check.

```json
{
  "pk": "SITE#bayview-haven",
  "sk": "CHECK#0d6d1a4e-8f1c-4a4b-9c2a-5e7e2c6b1f10#ANALYSIS#7b2f9c3e-1d44-4e0b-a6a1-3f1c9d8e2b77",
  "checkId": "0d6d1a4e-8f1c-4a4b-9c2a-5e7e2c6b1f10",
  "artifactId": "7b2f9c3e-1d44-4e0b-a6a1-3f1c9d8e2b77",
  "status": "analyzed",
  "analysisId": "ana_20260930_54234580279c",
  "rubricVersion": "1.0.0",
  "model": {
    "provider": "bedrock",
    "model_id": "us.anthropic.claude-sonnet-4-20250514-v1:0"
  },
  "grade": "Poor",
  "gradeDescription": "The perimeter has significant concerns that need attention: a pile of feces outside the front door; cans and paper scattered near the planter.",
  "concerns": [
    {
      "category": "Feces and urine",
      "rating": 3,
      "ratingLabel": "Moderate: Increasing amount, spread, or proximity to pedestrians",
      "userFriendlyLabel": "Feces outside front door",
      "explanation": "Large pile of feces on the sidewalk directly outside the front door",
      "evidenceIndices": [0]
    },
    {
      "category": "Litter",
      "rating": 2,
      "ratingLabel": "Minor: Increasing quantity, size, or spatial impact",
      "userFriendlyLabel": "Cans and paper near planter",
      "explanation": "Empty cans and scattered paper along the planter edge",
      "evidenceIndices": [0]
    }
  ],
  "issueCount": 2,
  "maxSeverity": 3,
  "capturedAt": "2026-09-30T15:03:27.000Z",
  "latitude": 37.7312,
  "longitude": -122.3826,
  "georeferencedAddress": "1600 Third St, San Francisco, CA 94158",
  "analyzedAt": "2026-09-30T15:04:55.000Z"
}
```

When the analyzer rejects an input for good, the worker writes a failed marker instead.
A later retry of the same artifact may overwrite it:

```json
{
  "pk": "SITE#bayview-haven",
  "sk": "CHECK#0d6d1a4e-…#ANALYSIS#7b2f9c3e-…",
  "checkId": "0d6d1a4e-…",
  "artifactId": "7b2f9c3e-…",
  "status": "failed",
  "error": { "code": "invalid_media", "status": 422, "message": "Image could not be decoded" },
  "analyzedAt": "2026-09-30T15:04:55.000Z"
}
```

## 4. Assessment

Written by the guidance step in one transaction with its conditions and tasks. `lineageId`
is the artifact ID; it ties every later refresh of this assessment to the same photo.
`summary` is a count of what the conditions and tasks look like right now. `rawAssessment`
is the full analyzer payload and is trimmed here. `gsi1pk` and `gsi1sk` put the item in the
GSI1 assessments timeline.

```json
{
  "pk": "SITE#bayview-haven",
  "sk": "ASSESSMENT#c1a7e2d4-55b3-4f0e-8a9d-2b6c7d8e9f01",
  "gsi1pk": "SITE#bayview-haven#ASSESSMENT",
  "gsi1sk": "2026-09-30T15:03:27.000Z#c1a7e2d4-55b3-4f0e-8a9d-2b6c7d8e9f01",
  "entityType": "ASSESSMENT",
  "assessmentId": "c1a7e2d4-55b3-4f0e-8a9d-2b6c7d8e9f01",
  "checkId": "0d6d1a4e-8f1c-4a4b-9c2a-5e7e2c6b1f10",
  "status": "tasks_created",
  "policyVersion": "actions-escalations-v3",
  "rubricVersion": "1.0.0",
  "grade": "Poor",
  "reportedAt": "2026-09-30T15:03:27.000Z",
  "assessmentRevision": 0,
  "lineageId": "7b2f9c3e-1d44-4e0b-a6a1-3f1c9d8e2b77",
  "summary": {
    "totalConditions": 2,
    "conditionsNeedAnswer": 0,
    "conditionsResolvedToTasks": 2,
    "openTaskCount": 2,
    "actionCount": 1,
    "escalationCount": 1,
    "emergencyCount": 0,
    "manualReviewCount": 0
  },
  "rawAssessment": { "…": "full analyzer response, trimmed" },
  "createdAt": "2026-09-30T15:05:10.000Z",
  "updatedAt": "2026-09-30T15:05:10.000Z"
}
```

`status` can be `needs_answers` (a rule needs the user to answer a question first),
`manual_review`, `tasks_created`, or `no_tasks`.

## 5. Condition

One per concern in the assessment. `conditionId` is the concern's position plus its
category slug. `outcome` is a copy of the matched rule's outcome at the time, so the
condition still reads correctly if the rule changes later. `gsi4pk` and `gsi4sk` put it in
the GSI4 condition history. It has no `gsi5pk`, because it was resolved into a task. A
condition that still needs an answer carries `gsi5pk` / `gsi5sk` too, which puts it in the
GSI5 unresolved queue.

```json
{
  "pk": "SITE#bayview-haven",
  "sk": "ASSESSMENT#c1a7e2d4-55b3-4f0e-8a9d-2b6c7d8e9f01#COND#001-feces-and-urine",
  "gsi4pk": "SITE#bayview-haven#CONDITION#SEV#3",
  "gsi4sk": "2026-09-30T15:03:27.000Z#c1a7e2d4-55b3-4f0e-8a9d-2b6c7d8e9f01#001-feces-and-urine",
  "entityType": "CONDITION",
  "conditionId": "001-feces-and-urine",
  "assessmentId": "c1a7e2d4-55b3-4f0e-8a9d-2b6c7d8e9f01",
  "checkId": "0d6d1a4e-8f1c-4a4b-9c2a-5e7e2c6b1f10",
  "policyVersion": "actions-escalations-v3",
  "source": {
    "artifactIds": ["7b2f9c3e-1d44-4e0b-a6a1-3f1c9d8e2b77"],
    "evidenceIndices": [0],
    "reportedAt": "2026-09-30T15:03:27.000Z",
    "latitude": 37.7312,
    "longitude": -122.3826,
    "positionDescriptor": "perimeter"
  },
  "analyzerCategory": "Feces and urine",
  "canonicalCategory": "Feces and urine",
  "severity": 3,
  "severityLabel": "Moderate: Increasing amount, spread, or proximity to pedestrians",
  "userFriendlyLabel": "Feces outside front door",
  "description": "Large pile of feces on the sidewalk directly outside the front door",
  "answers": {},
  "status": "tasks_created",
  "selectedRuleId": "FECES-1",
  "outcome": {
    "kind": "escalation",
    "label": "Do not touch it. Report it to the City.",
    "buttons": ["File 311 ticket"],
    "appActions": [
      {
        "code": "create_311_ticket",
        "payload": {
          "serviceCodeOrAction": "1.1.4.7.9.0",
          "responsibleAgencyCode": "",
          "executionTrigger": "user_confirmed"
        }
      }
    ],
    "category311": "1.1.4.7.9.0",
    "guidance": "Stay away from it. Use the app to file a 311 ticket so the City can clean it up.",
    "cannotDoReasons": ["We already filed a ticket"],
    "source": "Policy line 70; public SF311 taxonomy"
  },
  "taskIds": ["4f8e2b1c-9a3d-4c7e-b2f5-6d1a8c9e0b23"],
  "resolvedToTasks": true,
  "needsAnswer": null,
  "cannotDo": null,
  "createdAt": "2026-09-30T15:05:10.000Z",
  "updatedAt": "2026-09-30T15:05:10.000Z"
}
```

## 6. Task

Created from the condition above by rule `FECES-1`. `kind` comes from the rule.
`type` is derived from `kind`: `action` becomes `onsite`, anything else becomes
`city_escalation`. `shortId` is what staff see on the card. `gsi2pk` and `gsi2sk` put the
task in the GSI2 worklist for its current status. Both change on every status change.

```json
{
  "pk": "SITE#bayview-haven",
  "sk": "TASK#4f8e2b1c-9a3d-4c7e-b2f5-6d1a8c9e0b23",
  "gsi2pk": "SITE#bayview-haven#TASK#open",
  "gsi2sk": "2026-09-30T15:05:10.000Z#escalation#3#4f8e2b1c-9a3d-4c7e-b2f5-6d1a8c9e0b23",
  "entityType": "TASK",
  "taskId": "4f8e2b1c-9a3d-4c7e-b2f5-6d1a8c9e0b23",
  "shortId": "ECS-BVH-042",
  "assessmentId": "c1a7e2d4-55b3-4f0e-8a9d-2b6c7d8e9f01",
  "checkId": "0d6d1a4e-8f1c-4a4b-9c2a-5e7e2c6b1f10",
  "conditionId": "001-feces-and-urine",
  "policyVersion": "actions-escalations-v3",
  "maxAcceptableResponseHours": 24,
  "ruleId": "FECES-1",
  "kind": "escalation",
  "type": "city_escalation",
  "status": "open",
  "category": "Feces and urine",
  "analyzerCategory": "Feces and urine",
  "severity": 3,
  "userFriendlyLabel": "Feces outside front door",
  "label": "Do not touch it. Report it to the City.",
  "description": "Large pile of feces on the sidewalk directly outside the front door",
  "guidance": "Stay away from it. Use the app to file a 311 ticket so the City can clean it up.",
  "buttons": ["File 311 ticket"],
  "appActions": [
    {
      "code": "create_311_ticket",
      "payload": {
        "serviceCodeOrAction": "1.1.4.7.9.0",
        "responsibleAgencyCode": "",
        "executionTrigger": "user_confirmed"
      }
    }
  ],
  "appActionStatus": "pending",
  "appActionResults": [],
  "category311": "1.1.4.7.9.0",
  "cannotDoReasons": ["We already filed a ticket"],
  "sourceArtifactIds": ["7b2f9c3e-1d44-4e0b-a6a1-3f1c9d8e2b77"],
  "source": {
    "latitude": 37.7312,
    "longitude": -122.3826,
    "positionDescriptor": "perimeter"
  },
  "createdAt": "2026-09-30T15:05:10.000Z",
  "updatedAt": "2026-09-30T15:05:10.000Z"
}
```

### The same task after staff file the 311 ticket

Only the fields that change are shown. The task moves to the `completed` worklist
partition, and the 311 result is recorded on the task itself. There is no separate ticket
item.

```json
{
  "gsi2pk": "SITE#bayview-haven#TASK#completed",
  "gsi2sk": "2026-09-30T15:05:10.000Z#escalation#3#4f8e2b1c-9a3d-4c7e-b2f5-6d1a8c9e0b23",
  "status": "completed",
  "completionMethod": "311_filed",
  "completedAt": "2026-09-30T15:41:03.000Z",
  "appActionStatus": "submitted",
  "appActionResults": [
    {
      "code": "create_311_ticket",
      "status": "submitted",
      "payload": {
        "serviceCodeOrAction": "1.1.4.7.9.0",
        "responsibleAgencyCode": "",
        "executionTrigger": "user_confirmed",
        "tickets": [
          {
            "serviceCode": "1.1.4.7.9.0",
            "srNum": "101234567",
            "responsibleAgency": "DPW"
          }
        ]
      },
      "externalId": "101234567",
      "recordedAt": "2026-09-30T15:41:03.000Z"
    }
  ],
  "updatedAt": "2026-09-30T15:41:03.000Z"
}
```

## Reading these together

- **Check detail screen.** One query, `pk = SITE#bayview-haven AND begins_with(sk, "CHECK#0d6d1a4e-…")`,
  returns items 1, 2, and 3.
- **Checks list.** One GSI1 query on `gsi1pk = SITE#bayview-haven` returns item 1 and every
  other header, newest first. The `grade` on the header is why the list needs nothing else.
- **Staff worklist.** One GSI2 query on `gsi2pk = SITE#bayview-haven#TASK#open` returns
  item 6 and every other open task.
- **Guidance screen.** `GetItem` on item 4, then a query for `begins_with(sk, "ASSESSMENT#c1a7e2d4-…#COND#")`
  returns item 5 and its siblings.
