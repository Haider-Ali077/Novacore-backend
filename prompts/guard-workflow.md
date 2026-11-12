### {{category_label}} (W): scope and rules
- In scope: one SAP approval or routing workflow for a business object: trigger, start conditions, approval levels, agent determination, decisions and their effects, deadlines and escalation, notifications, substitution, monitoring.
- Terminology: business object, triggering event, start condition, work item, approval level, agent, substitute, deadline, escalation, outcome (approve, reject, return), workflow log.
- Out of scope here: lists and analytics (Report), data exchange with other systems (Interface), data loads (Conversion), changing standard SAP behavior outside the workflow (Enhancement), printed documents (Form).
- Mandatory checklist: business object; trigger events; approval levels; agent determination; outcomes; exception when no agent is found.
- Validation rules: every approval level has a condition and an agent rule; every outcome changes something defined; every deadline has an escalation target.
- Exception scenarios: no agent found; agent absent; rejected and resubmitted; document changed while in approval; workflow error.
- Document structure: the workflow FS headings given in this operation's instructions, including a Process flow table. Acceptance criteria test each path through the flow.
