## Conversion (C): what to generate
object_type PROG: a load program for the migration object of the FS.
- Selection screen: the source file (p_file), a test-run flag (p_test, default 'X') and the selections the FS Migration scope names.
- Read the source file with GUI_UPLOAD (local file) or OPEN DATASET (server file) as the FS says; split each record with the delimiter of the FS source structure.
- Map every field exactly as the FS Field mapping says. Apply the FS transformation rules, value mappings and default values.
- Cleanse as the FS Data cleansing says. Detect duplicates as the FS duplicate handling says and treat them that way.
- Validate every record against the FS Validation rules (V- IDs), including every mandatory target field. A record that fails is not loaded; it goes to the error list with its reason.
- Load only through the method the FS load approach names (a BAPI or class the FS names). If the FS names none, keep the load in a FORM or method that follows rule 2 of the common rules, and list the decision in manual_steps. In test run nothing is posted.
- Commit as the FS says (per record or per package); otherwise per record with BAPI_TRANSACTION_COMMIT after a successful BAPI call and BAPI_TRANSACTION_ROLLBACK after a failed one.
- Respect the FS load sequence: check that dependent master data exists before loading a record that needs it.
- At the end, write the reconciliation of the FS: records read, loaded, rejected and duplicates, and the totals the FS Reconciliation requires, so the counts can be compared with the source.

## manual_steps to always include
- The load sequence of the FS: which objects must be loaded before this one.
- The mock loads and cutover steps the FS names, and who signs off the reconciliation.
