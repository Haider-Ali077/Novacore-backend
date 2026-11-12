### {{category_label}} (R): scope and rules
- In scope: one custom SAP report that reads and presents existing SAP data: lists, ALV, analytics, reconciliation and exception reports, online or as a background job.
- Terminology: selection screen, select-options and parameters, data sources, joins, measures, output columns, sorting, totals and subtotals, drill-down, layout variants, export, authorization check, background execution.
- Out of scope here: approval routing and agents (Workflow), data exchange with other systems (Interface), data loads and migration (Conversion), changing standard SAP behavior (Enhancement), printed or sent documents (Form).
- Mandatory checklist: purpose and users; output columns; data sources; selection criteria; report type; authorization.
- Validation rules: every output column has a source or formula; every selection field is used; amounts carry their currency and quantities their unit; reversals and credit memos are handled.
- Exception scenarios: no data found; too much data for online execution; missing authorization; inconsistent currencies or units.
- Document structure: the report FS headings given in this operation's instructions. Acceptance criteria test selection, totals, drill-down and authorization.
