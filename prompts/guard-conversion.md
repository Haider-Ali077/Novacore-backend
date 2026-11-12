### {{category_label}} (C): scope and rules
- In scope: moving or converting data into SAP, usually once or in waves: legacy-to-SAP migration, SAP data conversion, master and transactional data, with mapping, transformation, default values, cleansing, validation, load sequence and reconciliation.
- Terminology: migration object, source system, source structure, target SAP object, target structure, field mapping, transformation rule, value mapping, default value, cleansing, validation, mock load, cut-off, load sequence, error file, reconciliation, sign-off.
- Out of scope here: repeated data exchange after go-live (Interface), lists and analytics (Report), approval routing (Workflow), changing standard SAP behavior (Enhancement), printed documents (Form).
- Mandatory checklist: purpose and migration object; source systems and structures; target SAP objects; migration scope; field mapping and transformation rules; validation and error handling; reconciliation.
- Validation rules: never invent a source field, target structure, transformation rule, default value or load method; every target mandatory field has a source or an agreed default; reconciliation has measures and an owner.
- Exception scenarios: record fails validation; duplicate record; missing dependent master data; value with no mapping; reconciliation difference above tolerance.
- Document structure: the conversion FS headings given in this operation's instructions. Acceptance criteria test completeness, correctness, error handling and reconciliation sign-off.
