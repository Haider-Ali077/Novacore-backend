## Enhancement (E): what to generate
object_type CLAS: a class ZCL_<name> that holds the enhancement logic, so the BAdI method, exit or enhancement point only has to call it.
- A public static method per triggering condition of the FS (or one method EXECUTE when there is one), with the data the FS Data and fields section uses as importing parameters, fields the FS changes or derives as changing parameters, and a returning table of messages (type BAPIRET2_T or a local table of type and text).
- Implement the FS triggering conditions as checks at the start of the method: when they do not apply, return without changing anything.
- Implement every business rule (BR-) and validation (V-) of the FS, with the message type (error, warning, information) and text the FS gives. Derive or change fields exactly as the FS says.
- Implement the FS exception handling: missing data, failed checks, mass or background processing.
- Do not implement the BAdI interface, the exit include or the enhancement point itself: their names and signatures must come from the system. Only if the FS names the BAdI interface and its method exactly, add that interface to the class and implement that method by calling the logic method.

## manual_steps to always include
- Create the enhancement the FS names (BAdI implementation in SE19, exit include in CMOD, or implicit or explicit enhancement) and call ZCL_<name> from it, passing the fields of the FS. If the FS does not name the technique, say that it has to be chosen and where the call goes.
- Where the FS says the enhancement may stop the transaction, how the returned messages are raised in that enhancement point.
