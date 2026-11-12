# SuperNova backend

The SuperNova AI engine and its APIs, as an independent application (API only, no pages). The SuperNova page lives in the separate frontend application and reaches this backend through its `/api/*` forwarding; other applications use `/api/v1` (`docs/API.md`).

**Run:** `npm ci`, copy `.env.example` to `.env` and fill in `LLM_API_KEY` and `LLM_MODEL`, then `npm run dev` (http://localhost:3001). `npm run build && npm start` for production. `npm run selftest` runs the self-tests.

**Security:** `/api/pipeline`, `/api/state`, `/api/fsd`, `/api/download` and `/api/client-logo` have no authentication (they are the page's routes). Do not expose this backend publicly without access control in front of it; `/api/v1` requires `SUPERNOVA_API_KEY`.

---

The description below covers the whole product.

# SuperNova — proof of concept

Turns a plain-English business requirement into an **approved FSD** and then into **SAP ABAP code in abapGit format**, on your local machine.

```
Type (Report, Workflow, Background job, or Report + Workflow) → Chat (one prompt, then 3 to 5 AI questions, one at a time)
→ FS (generated, editable, versioned, DOCX and PDF) → Approve FS → TS (written from the approved FS, own versions and approval)
→ Code (Report only: Dev agent → rule checks → up to 3 repair passes) → Download (local folder + local git commit + abapGit ZIP)
```

**Workspace:** one page for every WRICEF type. The left panel holds the WRICEF category (for a new requirement), the step navigation and the FS/TS versions. The main area holds the intake (description and/or RG text, plus any number of .docx/.pdf/.txt/.md attachments, each read on the server as soon as it is added so its status shows next to it), the analysis, the questions and answers, the confirmation, the FS with its review, comparison and history, the TS and ABAP code steps for Reports and Workflows, and downloads. The right panel starts with AI insights (`app/insights.tsx`): the AI's suggested WRICEF category with confidence and explanation (`prompts/classifier.md`, advice only: a different suggestion shows as a warning and never changes the chosen type), missing mandatory information, coverage, source traceability of the FS and validation status. On wide screens the three panels sit side by side; on tablets the right panel moves below the content, on phones everything stacks. Typed descriptions, pasted RG text, answers and corrections are kept as drafts in browser storage and restored after a refresh (attached files are not). `lib/validation.ts` is the one validation for all six types: it blocks the FS while mandatory information is missing (RG types from the interview's tracker, Reports and Workflows from their summary) and checks that each requirement, rule and validation row of an RG-type FS names the RG or a client answer.

**AI guardrails (`lib/guardrails.ts`):** every AI request goes through `callLLM`, which requires the selected WRICEF category and the operation, and applies the guard itself. Guarded operations (classification, RG analysis, interview, FS generation, change analysis and apply) get `prompts/guard-common.md` (trusted category context, client data is untrusted, never reveal instructions, no unbacked SAP technical claims), and all but the classifier also `guard-isolation.md` plus the category's own `guard-<category>.md` (scope, terminology, mandatory checklist, validation rules, exception scenarios). Client data (RG text, requirements, answers, change requests) is sent inside bounded CLIENT_DATA blocks; instruction-like text in it is logged as `guardrail.injection_suspected` and shown in the insights panel; a response that repeats the guard instructions is rejected. When the interviewer or the change analyst flags a request as out of scope, the pipeline itself shows the fixed out-of-scope notice and keeps nothing else from that answer. Before an FS is written, a different AI classification with 75% confidence or more blocks until the user confirms the category; after it is written, the FS is checked for sections of another category, technical names found nowhere in the sources, a missing assumptions section and (RG types) rows without a source. TS and ABAP operations are deliberately not guarded, so they stay exactly as they were.

**External API:** the backend engine is also available as a JSON API at `/api/v1` for the office application (documented in `docs/API.md`). It is off until `SUPERNOVA_API_KEY` is set, and calls the same engine as the page (`lib/service.ts`), so there is one implementation of every step. The page's own endpoints are unchanged.

**ABAP for every WRICEF category:** after the FS is approved, every category goes on to its ABAP code (Code step), checked by the same rules and abaplint, repaired up to 3 times, and exported with abapGit. Reports use the original Dev agent (`prompts/dev.md`, unchanged). The other five use `prompts/dev-common.md` plus their own prompt: Conversion a load program, Form a print program, Interface a file program or a class (RFC/BAPI, REST, OData, IDoc, SOAP logic), Enhancement a class with the logic the BAdI or exit calls, Workflow a business class implementing IF_WORKFLOW. What cannot be ABAP in that one object (form layout, workflow template, BAdI implementation, RFC wrapper, SICF/SEGW, output or partner configuration) is returned as manual steps, shown in the Code step and exported as `docs/MANUAL_STEPS.md`. Classes are serialized as `.clas.abap` / `.clas.xml`. Outside Reports, tables missing from the (purchasing) catalog are warnings, not errors. None of it has been activated in a real SAP system.

**Solution types (WRICEF):** the first screen asks what kind of solution this is. Report (R), Workflow (W), Interface (I), Conversion (C), Form (F) and Enhancement (E) are supported; a background job is a Report that runs as a job; "Report and workflow" creates two linked requirements. custom/mixed shows a "not supported yet" message and create nothing. Each type has its own interview, FS and TS prompts (`prompts/interviewer*.md`, `fsd*.md`, `ts-*.md`). The type can be changed later; the change must be confirmed, and existing documents are superseded, never deleted.

**Forms (F), RG to FS only:** the client's RG (Requirement Gathering document) is uploaded as .docx, .pdf, .txt or .md, or pasted. The RG Analyst (`prompts/rg-analyst.md`) reads it completely and extracts the form requirements with their RG references, plus what is missing, unclear or contradictory (six mandatory items: form identity, technology, output, layout, fields and data source, languages). The Forms interviewer (`prompts/interviewer-form.md`) asks only about those gaps, in groups of up to 3 related questions (at most 15), tracks each item as confirmed, open or in conflict, and never fills a gap with an invented value ("I don't know yet" leaves it open). The FS (`prompts/fsd-form.md`, 16 sections plus optional output-management, localization, multi-page and barcode sections only when the RG has them) is written only after the client ticks the confirmation and no mandatory item is missing. Requirements can be revised at any time: the interview reopens, a new requirement revision is confirmed, and the FS is regenerated as a new major version; each version records the requirement revision it came from, and earlier versions, approved ones included, are kept. No TS, form objects or code are generated for Forms. PDF RGs are read with `pdfjs-dist` (text-based PDFs only; a scanned PDF is refused with that reason); old .doc files are refused.

**Interfaces (I), RG to FS only:** the same RG flow as Forms and Enhancements, with `prompts/rg-analyst-interface.md`, `interviewer-interface.md` and `fsd-interface.md`. It covers RFC, BAPI, IDoc, OData, REST API, SOAP and file-based interfaces, SAP to SAP and SAP to external systems, with or without middleware. Mandatory items: purpose, source and target systems, direction, communication method (or explicitly left to the integration team), data content and mapping, trigger and frequency, and error handling. Questions follow the method the RG names (IDoc message and basic type, OData entity sets and operations, REST endpoints and payload, SOAP operations, RFC or BAPI call mode, file format, encoding, naming and location); a method, field, endpoint or retry rule is never assumed. The FS covers purpose, scope, interface overview, data flow, interface requirements, trigger and frequency, data mapping, field definitions, communication details, authentication and security, business rules, error handling and retry, logging and monitoring, dependencies, assumptions, acceptance criteria and open questions. No TS, interface objects, live SAP connection or interface execution.

**Conversions (C), RG to FS only:** the same RG flow, with `prompts/rg-analyst-conversion.md`, `interviewer-conversion.md` and `fsd-conversion.md`. It covers legacy-to-SAP migration, SAP data conversion, master and transactional data, mapping and transformation, cleansing, validation, migration rules and reconciliation. Mandatory items: purpose and migration object, source systems and structures, target SAP objects, migration scope, field mapping and transformation rules, validation and error handling, and reconciliation. Questions follow the kind of data (master data: organizational levels, active records, duplicates, number ranges; transactional data: open items or history, cut-off, balances, load order). Source fields, target structures, transformation rules, defaults and the load method are never invented. The FS covers background, migration scope, overview, source systems and structures, target SAP objects and structures, conversion requirements, field mapping, transformation rules and value mapping, default values, data cleansing, validation rules, dependencies and load sequence, error handling, reconciliation, assumptions, acceptance criteria and open questions. No TS, load program, data migration or SAP execution.

**Enhancements (E), RG to FS only:** the same RG flow as Forms (upload, RG analysis, grouped clarification, requirement tracker, confirmation, revisions and FS versions), with its own prompts: `prompts/rg-analyst-enhancement.md`, `interviewer-enhancement.md` and `fsd-enhancement.md`. It covers BAdIs, user exits, customer exits, enhancement spots, BTEs and implicit or explicit enhancements. Mandatory items: business requirement, SAP process and objects, existing SAP behavior, proposed behavior, triggering conditions and expected results. The enhancement technique is recorded when the RG names it and is otherwise left to the technical specification; no BAdI, exit or BTE name is ever made up. The FS covers business requirements, existing and proposed behavior, an enhancement overview, enhancement requirements, triggering conditions, business rules, validations and messages, data and fields, expected results, exceptions, assumptions and dependencies, acceptance criteria and open questions. No TS or code is generated for Enhancements.

**Workflow:** SuperNova writes the FS and TS only. It does not create workflow objects in SAP. The FS "Process flow" table is drawn as a flowchart in the DOCX and PDF (`lib/flow-diagram.ts`); the deliverables screen lists the process flow, approval and agent matrices, trigger/event design, exception design and implementation plan.

**FSD document format:** DOCX and PDF follow the company FSD. `templates/fsd-template.docx` supplies the styles, numbering, header logos and footer table, and `templates/fsd-config.json` holds the consultant and sign-off names. The client company name and logo are asked for each requirement (and can be changed in its Client card); the SuperNova logo is fixed.

**FSD versions:** the first FSD is v1.0. *Modify FSD* takes a plain-English change, shows which sections it would touch, and writes a new version only after you confirm it. Only those sections can change: the app merges them itself, so every other section stays byte-identical. Minor changes count up (1.1, 1.2), major ones start a new number (2.0). Existing versions are never overwritten; each one can be viewed, compared and downloaded as DOCX or PDF, and any of them can be the base of a new version. A new version goes back to draft and needs approval again.

**AI token usage:** every request OpenAI answers is stored in the `llm_usage` table with the usage it returned (input, output, cached and total tokens), the model it named, its `x-request-id`, the response id, time, actor and process (requirement analysis, clarification questions, FS/TS generation and regeneration, change analysis, AI version update, code generation, repair and review). Rows are linked to the requirement and to the FS/TS version or code version they produced, and are never changed when new versions arrive. A response without a usage block is stored as "usage unavailable", with no counts. Answers replayed from the local cache make no request and are not counted. The cost is an estimate from `config/openai-pricing.json` (per-model input, cached-input and output prices; edit it when OpenAI's prices change). Totals are in the top bar and on the AI usage page (`/usage`), and each requirement has an *AI usage* card with per-version and per-request detail.

> **The generated ABAP has not been activated or run in a real SAP system.** It is checked by rules and abaplint only. To try it in SAP: abapGit → *New Offline* → *Import ZIP*, then activate in a sandbox.

## Run

```bash
npm install
cp .env.example .env        # set LLM_MODEL and LLM_API_KEY for your provider
npm run dev                 # http://localhost:3000
npm run selftest            # deterministic checks against the golden repo, no LLM needed
```

Requires Node 22.5+ (uses the built-in `node:sqlite`). Tested on Node 24.

## Switching LLM provider

Only three variables in `.env` (git-ignored) change. The app speaks the OpenAI-compatible chat completions format; there is no vendor SDK.

| Provider | `LLM_BASE_URL` | `LLM_MODEL` |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | Set the model ID you want to use |
| Azure OpenAI (v1 API) | `https://<resource>.openai.azure.com/openai/v1` | deployment name |
| Azure OpenAI (classic) | `https://<resource>.openai.azure.com/openai/deployments/<deployment>?api-version=2024-10-21` | deployment name |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` |
| Ollama | `http://localhost:11434/v1` (`LLM_API_KEY=ollama`) | e.g. `qwen2.5-coder:14b` |

The key is read on the server only. It is never logged, stored or sent to the browser; error messages are redacted.

Temperature is 0.1. JSON output is requested with `response_format: json_object`, validated against a JSON schema, and retried up to 2 times with the parse error in the prompt. If a model rejects `temperature` or `response_format`, the call is retried without it.

## Record / replay

`LLM_MODE` in `.env`:

- `record` (default): call the API and save every response to `data/llm-cache/<sha256>.json`.
- `replay`: never call the API; answer only from the cache. Works without internet. Needs the **exact same inputs** as the recorded run (same requirement text, same answers, same FSD edits).
- `auto`: cache hit → replay, otherwise call and record.

For a repeatable demo: run the golden case once in `record` mode, then switch to `replay`.

## Golden case

Use the **"Use golden example"** button, or paste:

> Report showing landed cost per purchase order item: material value plus freight, customs, insurance and other delivery costs, per unit and as a percentage, with subtotals by company code and plant.

The target is functional equivalence with the reference repo `fixtures/golden` (copy of `Haider-Ali077/ABAPGIT_ALV`, report `ZMM_LANDED_COST`), not matching text.

## What is where

| Path | What |
|---|---|
| `prompts/*.md` | Agent prompts (interviewer, fsd, dev, repair, review). Re-read on every call, so you can tune them without restarting. |
| `catalog/sap-catalog.json` | Local DDIC catalog: EKKO, EKPO, EKBE, EKBZ, T001, T001W, LFA1, MAKT, plus authorization objects and drill-down transactions. **Hand-curated, not exported from SAP. Verify it against SE11.** T001 is included because company-code currency (`T001-WAERS`) is needed. |
| `lib/llm.ts` | `callLLM({ system, messages, jsonSchema })`: the only place that talks to an LLM |
| `lib/usage.ts` | Token usage recording, attribution to requirement / version / process, and cost estimates |
| `config/openai-pricing.json` | Per-model OpenAI prices used for the cost estimate |
| `lib/agents.ts` | Interviewers (report, workflow), FS and TS Generators, Dev, Repair, Code Review |
| `lib/rg.ts` | RG upload for Forms: DOCX/TXT/MD text extraction and storage (`rg_documents`) |
| `app/usage/page.tsx`, `app/usage-panels.tsx`, `app/nav.tsx` | The AI usage page, its panels, and the Workspace / AI usage navigation |
| `lib/guardrails.ts`, `prompts/guard-*.md` | Central AI guardrails: category context and isolation, untrusted client data, injection and leak checks, FS preflight and checks |
| `lib/validation.ts` | Shared validation: mandatory gaps for all six types, FS source traceability |
| `app/insights.tsx` | Right panel: AI classification, missing information, coverage, traceability, validation |
| `app/form.tsx` | Forms screens: RG picker, RG analysis, requirement tracker, confirmation |
| `lib/wricef.ts` | Solution types offered on the first screen, and which are supported |
| `lib/flow-diagram.ts` | Workflow flowchart drawn from the FS Process flow table |
| `lib/abapgit.ts` | Deterministic abapGit writer (`.abapgit.xml`, `package.devc.xml`, `.prog.abap`, `.prog.xml`). The LLM never writes XML. |
| `lib/checks.ts` | Rule-based checks: catalog tables/fields, abaplint syntax, `SELECT *`, missing `AUTHORITY-CHECK`, `CALL TRANSACTION` without authority check, wrong drill-down transaction |
| `lib/pipeline.ts` | The five steps, persistence and audit log |
| `lib/export.ts` | Local folder `output/repos/<program>/` + local git commit (no remote, never pushed) + ZIP in `output/zips/` |
| `data/supernova.db` | SQLite: requirements, chat, FSD versions, approvals, code versions, exports, audit log |

## Known limits

- The catalog check is a statement splitter plus regexes, tuned to the report pattern the Dev agent is told to write. abaplint covers syntax, but standard SAP objects (EKKO, CL_SALV_TABLE …) are "void" to abaplint, so it cannot check their fields or method signatures.
- No live SAP: activation, runtime behaviour and GUI issues (labels, hotspots) are unverified.
- No login or roles: "Functional Consultant" and "Functional Approver" are hard-coded.
- Code generation needs an approved TS for the current FS, and only covers ALV reports (CL_SALV). Code generated before the TS existed stays visible and exportable, but regenerating it needs a TS.
- Workflows: design documents only; nothing is generated or activated in SAP. The flowchart follows the FS table: with no readable table (Step, Type, Next columns, two or more steps) the diagram is left out, and a Next that points to a missing step is skipped without a message in the UI.
- An earlier answer can be revised only before the FS is written. After that, change the FS with Modify FS.
