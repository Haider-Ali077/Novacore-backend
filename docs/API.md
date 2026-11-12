# SuperNova API (v1)

A JSON API over the SuperNova backend engine, for the internal office application and other clients. It runs inside the same application as the SuperNova page and uses the same engine (`lib/`): the same WRICEF flows, interviews, AI guardrails, category blocking, FS/TS versions, approvals, ABAP generation and abapGit export. The page keeps using its own endpoints (`/api/pipeline`, `/api/state`, `/api/fsd`, `/api/download`); both call `performAction` in `lib/service.ts`.

## Setup

| Variable | Purpose |
|---|---|
| `SUPERNOVA_API_KEY` | Required. The key every API call must send. Without it the API answers 503 and stays off. |
| `SUPERNOVA_API_ORIGINS` | Optional. Comma-separated browser origins allowed to call the API (CORS), for example `https://office.example.com`. Not needed for server-to-server calls. |

Send the key as `Authorization: Bearer <key>` (or `X-API-Key: <key>`). Bodies are JSON; files are base64.

## Errors

Every error is `{ "error": { "code": string, "message": string } }`:
`unauthorized` 401, `api_disabled` 503, `not_found` 404, `method_not_allowed` 405, `invalid_request` 400 (the engine refused the step, for example a missing mandatory item, an unapproved FS or a category block; the message says why), `not_latest` 409, `not_approved` 403, `ai_error` 502 (the AI provider failed; the step can be repeated), `invalid_json` 400, `internal_error` 500.

## Flow

1. `GET /api/v1/categories`: the WRICEF categories.
2. `POST /api/v1/requirements`: create a requirement with its RG. The AI classifies it and, unless it is blocked for its category, asks its first question.
3. Repeat `POST /api/v1/requirements/{id}/answers` while `interview.waitingForAnswer` is true.
4. `POST /api/v1/requirements/{id}/fsd` with `confirmed: true` (the client confirms the requirements) writes the FS.
5. `POST /api/v1/documents/{docId}/approve` approves it; `GET /api/v1/documents/{docId}/file?format=docx` downloads it (approved versions only).
6. `POST /api/v1/requirements/{id}/code` generates the ABAP; `POST /api/v1/requirements/{id}/export` exports it; `GET /api/v1/exports/{exportId}/file` downloads the abapGit ZIP.

## Endpoints

| Method and path | Body | Result |
|---|---|---|
| `GET /api/v1` | | API name, version and endpoint list |
| `GET /api/v1/categories` | | `[{ code, id, label, description, startsFromRg }]` |
| `POST /api/v1/attachments/preview` | `{ attachments: [{ filename, contentType, data }] }` | Text extraction status per file, nothing stored |
| `GET /api/v1/requirements` | | The latest requirements `[{ id, title, status, category }]` |
| `POST /api/v1/requirements` | `{ category: "R"\|"W"\|"I"\|"C"\|"E"\|"F", client: { name, logo?, logoType? }, project?, text?, attachments?: [{ filename, contentType, data }], rgText? }` | 201, the requirement |
| `GET /api/v1/requirements/{id}` | | The requirement (see below) |
| `POST /api/v1/requirements/{id}/answers` | `{ text, finish? }` (`finish: true` = enough questions) | The requirement |
| `POST /api/v1/requirements/{id}/revisions` | `{ text }` | The requirement, with the interview reopened as the category allows |
| `POST /api/v1/requirements/{id}/classification` | | Re-runs the AI classification |
| `POST /api/v1/requirements/{id}/recategorize` | `{ category }` | 201, a new requirement in that category with the same RG, client and project |
| `PUT /api/v1/requirements/{id}/category` | `{ category: "R"\|"W", confirmed: true }` | Changes a Report to a Workflow or back |
| `PUT /api/v1/requirements/{id}/client` | `{ name, logo?, logoType? }` | The requirement |
| `POST /api/v1/requirements/{id}/fsd` | `{ confirmed?, scopeConfirmed? }` | Writes the FS (a new major version if one exists) |
| `POST /api/v1/requirements/{id}/ts` | | Writes the TS from the approved FS (Report and Workflow) |
| `POST /api/v1/requirements/{id}/changes` | `{ text, documentType?: "FS"\|"TS", baseDocumentId?, changeId? }` | Proposes a change (`changeId` refines an open one); see `fs.openChange` |
| `POST /api/v1/requirements/{id}/changes/{changeId}/apply` | `{ changeType?: "MINOR"\|"MAJOR" }` | Writes the new version |
| `DELETE /api/v1/requirements/{id}/changes/{changeId}` | | Discards the proposal |
| `POST /api/v1/requirements/{id}/comments` | `{ documentId, section, text }` | Adds a review comment |
| `POST /api/v1/requirements/{id}/code` | | Generates the ABAP with checks and repair passes |
| `POST /api/v1/requirements/{id}/code/review` | | AI code review of the latest code |
| `POST /api/v1/requirements/{id}/export` | `{ force? }` | abapGit export (`force` exports despite check errors) |
| `GET /api/v1/requirements/{id}/usage` | | Token usage and cost of the requirement |
| `GET /api/v1/documents/{docId}` | | One FS/TS version with its Markdown text |
| `PUT /api/v1/documents/{docId}` | `{ markdown, summary? }` | Saves an edit of the latest version as a new version |
| `POST /api/v1/documents/{docId}/approve` | | Approves the version |
| `GET /api/v1/documents/{docId}/diff/{otherId}` | | Section-level comparison of two versions |
| `GET /api/v1/documents/{docId}/file?format=docx\|pdf` | | The document file (approved versions only) |
| `GET /api/v1/exports/{exportId}/file` | | The abapGit ZIP |
| `GET /api/v1/usage` | | Token usage and cost across all requirements |

## The requirement resource

`id, title, status, category { code, label }, executionMode, project, client, linkedRequirementId, createdAt, updatedAt,`
`classification` (AI category, confidence, explanation), `categoryBlock` (set when the requirement cannot continue in its category, with the AI result),
`interview { questionsAsked, maxQuestions, waitingForAnswer, coverage, contradictions, tracked, mandatoryMissing, messages[] }`, `summary, revisions, rg, attachments,`
`fs { current, versions, openChange }`, `ts { current, versions, openChange }`, `approvals[]`,
`code { blocker, versions[{ id, version, kind, objectType, name, title, source, selectionTexts, manualSteps, checks, review }] }`, `exports[]`,
`validation { mandatoryGaps, traceability, fsChecks, guardrailEvents }`, `usage`.

## Notes

- Same data and rules as the page: what the API creates appears in the page and the other way round, and every guardrail, category block, approval rule and check applies to both.
- AI steps take seconds to minutes; a client should allow long request timeouts (on Vercel, the function time limit of the plan applies).
- Actions are recorded in the audit log under the same fixed actors as the page ("Functional Consultant", "Functional Approver"); there are no per-user identities yet.
- The API does not change the database structure and adds no data of its own.
