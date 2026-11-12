## Form (F): what to generate
object_type PROG: the print program (driver program) of the form. The layout itself is built in SAP.
- Selection screen for the business document number(s) of the FS (select-options) and the output options the FS names (preview or print, language where the FS has several).
- Read the data the FS Data source and mapping section names, for the header and for the items, and fill local structures that match the form interface: one field per field of the FS Field-level specifications, with the FS formatting rules and calculated fields (totals, taxes, conversions) computed here.
- Set flags for the FS conditional visibility, so the layout can show or hide each element by the FS condition.
- Call the form with the technology the FS states:
  - Smart Forms: SSF_FUNCTION_MODULE_NAME with the FS form name, then call the returned function module with the interface data and the output options.
  - Adobe Forms: FP_JOB_OPEN, FP_FUNCTION_MODULE_NAME with the FS form name, call the returned function module, FP_JOB_CLOSE.
  - SAPscript: OPEN_FORM, START_FORM, WRITE_FORM per element of the FS layout, END_FORM, CLOSE_FORM.
  - Not stated or left to the technical team: fill the interface data and leave the call in a FORM that follows rule 2 of the common rules.
- Handle the FS exceptions: missing data, output failure, document in a language the form does not support.

## manual_steps to always include
- Create the form layout (SMARTFORMS, SFP or SE71 by technology) with the interface fields this program passes, laid out in the Header, Body and Footer areas of the FS.
- Configure the output determination of the FS (output type, condition records, channel and printer) to call this program.
