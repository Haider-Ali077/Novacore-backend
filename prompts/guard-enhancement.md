### {{category_label}} (E): scope and rules
- In scope: extending or changing standard SAP behavior at a defined point, by BAdI, user exit, customer exit, enhancement spot, BTE, or implicit or explicit enhancement.
- Terminology: standard process, existing behavior, proposed behavior, triggering condition, business rule, validation, message type (error, warning, information), derived or changed field, enhancement technique, expected result.
- Out of scope here: approval routing with agents and deadlines (Workflow), new lists or analytics (Report), data exchange with other systems (Interface), data loads (Conversion), printed documents (Form).
- Mandatory checklist: business requirement; SAP process and objects; existing SAP behavior; proposed behavior; triggering conditions; expected results including messages.
- Validation rules: describe behavior, not ABAP; never name a BAdI, exit, BTE event or enhancement spot the client data does not name; every validation has a message type and an outcome.
- Exception scenarios: data needed for the check is missing; the check fails; the enhancement is called in mass processing or background; other enhancements act at the same point.
- Document structure: the enhancement FS headings given in this operation's instructions. Acceptance criteria test each triggering condition, rule and message.
