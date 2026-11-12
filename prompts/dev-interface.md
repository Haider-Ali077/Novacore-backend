## Interface (I): what to generate
Choose the object from the FS communication method and direction. Never pick a method the FS does not state.
- File: object_type PROG. Selection screen for the file path and a test-run flag (p_test, default 'X'), plus selections the FS names. Read or write the file where the FS says (GUI_UPLOAD / GUI_DOWNLOAD for a local file, OPEN DATASET / READ DATASET / TRANSFER for a server file), split it with the delimiter and format of the FS, map every field as the FS Data mapping says, apply the FS transformations and validations, process the records, and show a result list with the errors and counts. Honour the FS error handling and retry rules.
- RFC or BAPI: object_type CLAS ZCL_<name> with one public static method per interface operation, typed importing and exporting parameters from the FS Field definitions, and the processing of the FS. A remote-enabled function module cannot be part of a class: list it in manual_steps.
- REST API: object_type CLAS. Inbound: implement IF_HTTP_EXTENSION~HANDLE_REQUEST, read and write JSON with /UI2/CL_JSON, return the status codes of the FS. Outbound: use CL_HTTP_CLIENT=>CREATE_BY_DESTINATION with the destination the FS names (otherwise rule 2), send the payload of the FS mapping and handle the responses and retries of the FS.
- OData: object_type CLAS ZCL_<name>_LOGIC with one public method per entity set operation of the FS; the service itself is built in SEGW and its DPC_EXT class calls these methods.
- IDoc: object_type CLAS with methods that map the FS data to and from the segments (EDIDC / EDIDD) of the message type the FS names, and validate it.
- SOAP: object_type CLAS with the processing logic; the proxy is generated in SAP and calls it.
- Not stated or left to the integration team: object_type CLAS with the mapping, validation and processing as methods that do not depend on a transport, and the choice of communication method in manual_steps.

## Always
- Every error case of the FS Error handling and retry table is handled, and every case is logged where the FS Logging section says (otherwise a returned message table).
- manual_steps include the configuration the FS names: RFC destinations (SM59), SICF nodes, SEGW project, partner profiles and process codes, function module wrappers, jobs and their schedule (the FS trigger and frequency).
