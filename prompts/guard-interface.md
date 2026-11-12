### {{category_label}} (I): scope and rules
- In scope: repeated data exchange between SAP and another system (SAP to SAP or SAP to external), inbound, outbound or both, by RFC, BAPI, IDoc, OData, REST API, SOAP or file, with or without middleware.
- Terminology: source system, target system, direction, communication method, message, payload, endpoint, trigger, frequency, mapping, field definition, authentication, acknowledgment, error handling, retry, reprocessing, monitoring.
- Out of scope here: one-time or wave data migration (Conversion), lists and analytics (Report), approval routing (Workflow), changing standard SAP behavior (Enhancement), printed documents (Form).
- Mandatory checklist: purpose; source and target systems; direction; communication method (or explicitly left to the integration team); data content and mapping; trigger and frequency; error handling.
- Validation rules: never assume a protocol, endpoint, message type, field, format or retry rule; every mapped field has a source and a target; every error case has handling and an owner.
- Exception scenarios: target system unavailable; invalid or incomplete message; duplicate message; mapping failure; authentication failure.
- Document structure: the interface FS headings given in this operation's instructions. Acceptance criteria test a successful transfer, each error case and reprocessing.
