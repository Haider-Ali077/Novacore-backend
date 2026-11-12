## Workflow (W): what to generate
The workflow template itself is configured in SAP, not written in ABAP. Generate the ABAP the workflow runs on:
- object_type CLAS: a business class ZCL_WF_<name> that implements IF_WORKFLOW, so it can be used in workflow tasks.
- Implement the interface methods BI_PERSISTENT~FIND_BY_LPOR, BI_PERSISTENT~LPOR, BI_PERSISTENT~REFRESH, BI_OBJECT~DEFAULT_ATTRIBUTE_VALUE, BI_OBJECT~EXECUTE_DEFAULT_METHOD and BI_OBJECT~RELEASE, with an instance key attribute for the business object key of the FS.
- One public instance method per System step of the FS Process flow (the background steps), implementing what the FS says the step does.
- One public method per agent rule of the FS Agent determination that returns the agents (user IDs) as the FS describes. Where the FS does not say how an agent is found, follow rule 2 of the common rules.
- A public static method that raises the triggering event of the FS for a given key, using CL_SWF_EVT_EVENT=>GET_INSTANCE and RAISE, with the event name declared as a constant.
- Deadlines, escalations and notifications that the template handles are not coded; they go into manual_steps.

## manual_steps to always include
- Create the workflow template (SWDD) or flexible workflow scenario following the FS Process flow, using ZCL_WF_<name> as the business object class.
- Create one task per approval step and per System step, bound to the generated methods, with the agent rules of the FS Agent determination.
- Link the triggering event of the FS to the workflow (event linkage in SWE2) with the start conditions of the FS.
- Configure the deadlines, escalations and notifications of the FS in the template.
