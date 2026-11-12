// WRICEF classification: the first question for every requirement. Report and Workflow are built
// end to end; Interfaces, Conversions, Forms and Enhancements go from an RG document to an approved FS (no TS or code yet);
// every other choice gets an honest message instead of a wrong specification.
// No I/O here, so the page and the server share it.

export type Wricef = "R" | "W" | "F" | "E" | "I" | "C";
export type ExecutionMode = "ONLINE" | "BACKGROUND";

export type Choice = {
  id: string;
  label: string;
  code: string; // the WRICEF letter, or "-" for choices that are not one category
  supported: boolean;
  hint: string;
  /** What starts when the choice is supported. */
  wricef?: Wricef;
  execution?: ExecutionMode;
  /** Report and Workflow parts created together and linked. */
  linked?: boolean;
  /** Starts from an uploaded or pasted RG (Requirement Gathering) document. */
  fromRg?: boolean;
  /** Not offered for new requirements; requirements created with it before keep working. */
  hidden?: boolean;
  /** Why it is not supported and what to do instead. */
  message?: string;
};

export const CHOICES: Choice[] = [
  { id: "report", label: "Report", code: "R", supported: true, wricef: "R", execution: "ONLINE", hint: "Lists, ALV, analytics, reconciliation and exception reports" },
  { id: "workflow", label: "Workflow", code: "W", supported: true, wricef: "W", hint: "Approvals, routing, deadlines and escalations" },
  {
    id: "job", label: "Background job", code: "R", supported: true, hidden: true, wricef: "R", execution: "BACKGROUND",
    hint: "Runs as a report in the background, with variants and a job schedule",
  },
  {
    id: "mixed", label: "Report and workflow", code: "R + W", supported: true, hidden: true, linked: true,
    hint: "One business need with a report part and an approval part, created as two linked requirements",
  },
  {
    id: "interface", label: "Interface", code: "I", supported: true, wricef: "I", fromRg: true,
    hint: "RFC, BAPI, IDoc, OData, REST, SOAP or file exchange, SAP to SAP or to external systems. From your RG document to an FS",
  },
  {
    id: "conversion", label: "Conversion", code: "C", supported: true, wricef: "C", fromRg: true,
    hint: "Legacy-to-SAP migration, master and transactional data conversion, mapping, cleansing and reconciliation. From your RG document to an FS",
  },
  {
    id: "enhancement", label: "Enhancement", code: "E", supported: true, wricef: "E", fromRg: true,
    hint: "BAdI, user exit, customer exit, enhancement spot, BTE, implicit or explicit enhancement. From your RG document to an FS",
  },
  {
    id: "form", label: "Form", code: "F", supported: true, wricef: "F", fromRg: true,
    hint: "SAPscript, Smart Forms or Adobe Forms: invoices, purchase orders, delivery notes. From your RG document to an FS",
  },
  {
    id: "custom", label: "Custom application or mixed", code: "-", supported: false, hint: "Several kinds of development in one request",
    message:
      "A custom application usually combines several kinds of development, such as screens, data storage, reports, approvals and interfaces. SuperNova can only take the Report, Workflow, Interface, Conversion, Form and Enhancement parts. Split the request: create the report part as a Report, the approval part as a Workflow, or both together with \"Report and workflow\". The other parts need a different tool.",
  },
];

const LABELS: Record<string, string> = { W: "Workflow", F: "Form", E: "Enhancement", I: "Interface", C: "Conversion" };
export const wricefLabel = (w?: string | null) => LABELS[w ?? ""] ?? "Report";
export const wricefCode = (w?: string | null) => (w && LABELS[w] ? w : "R");

/** Types that start from the client's RG document and end at an approved FS (no TS or code yet). */
export const fromRgType = (w?: string | null) => w === "F" || w === "E" || w === "I" || w === "C";

/** Words that usually mean another WRICEF type. Only a warning: the user decides, nothing is reclassified. */
const SIGNS: { label: string; pattern: RegExp }[] = [
  { label: "an Interface", pattern: /\b(idoc|rfc\b|bapi call|odata|web ?service|soap|rest api|edi\b|interface|middleware|cpi\b|pi\/po)/i },
  { label: "a Conversion", pattern: /\b(migration|migrate|data load|upload (of|the)? ?(legacy|master)|lsmw|legacy data|conversion program|one[- ]time load)/i },
  { label: "an Enhancement", pattern: /\b(badi|user[- ]exit|customer exit|enhancement spot|implicit enhancement|substitution|validation rule)/i },
  { label: "a Form", pattern: /\b(smart ?form|adobe form|sapscript|print (form|layout|output)|invoice print|purchase order print)/i },
];

export function otherTypeSigns(text: string): string[] {
  return SIGNS.filter((s) => s.pattern.test(text)).map((s) => s.label);
}

/** The RG Analyst's output, as far as the page and the audit log need it, for either RG type. */
type RgAnalysisLike = {
  forms?: { name: string; business_document: string; technology: string; rg_reference: string }[];
  enhancements?: { name: string; enhancement_type: string; sap_process: string; rg_reference: string }[];
  interfaces?: { name: string; interface_type: string; direction: string; source_system: string; target_system: string; rg_reference: string }[];
  conversions?: { name: string; data_category: string; source_system: string; target_object: string; rg_reference: string }[];
  is_forms_rg?: boolean;
  is_enhancement_rg?: boolean;
  is_interface_rg?: boolean;
  is_conversion_rg?: boolean;
  not_form_related?: string[];
  not_enhancement_related?: string[];
  not_interface_related?: string[];
  not_conversion_related?: string[];
} | null | undefined;

/** The forms, enhancements, interfaces or conversions the RG describes, in one shape. */
export function rgSubjects(a: RgAnalysisLike): { name: string; details: string[]; rg_reference: string }[] {
  if (a?.conversions) {
    return a.conversions.map((c) => ({ name: c.name, details: [c.data_category, `${c.source_system} → ${c.target_object}`], rg_reference: c.rg_reference }));
  }
  if (a?.interfaces) {
    return a.interfaces.map((i) => ({ name: i.name, details: [i.interface_type, i.direction, `${i.source_system} → ${i.target_system}`], rg_reference: i.rg_reference }));
  }
  if (a?.enhancements) return a.enhancements.map((e) => ({ name: e.name, details: [e.enhancement_type, e.sap_process], rg_reference: e.rg_reference }));
  return (a?.forms ?? []).map((f) => ({ name: f.name, details: [f.business_document, f.technology], rg_reference: f.rg_reference }));
}

/** False only when the analyst found nothing of this type in the RG. */
export const rgRelevant = (a: RgAnalysisLike) =>
  (a?.conversions ? a.is_conversion_rg : a?.interfaces ? a.is_interface_rg : a?.enhancements ? a.is_enhancement_rg : a?.is_forms_rg) !== false;

/** Requirements in the RG that belong to another WRICEF type. */
export const rgUnrelated = (a: RgAnalysisLike): string[] =>
  a?.not_conversion_related ?? a?.not_interface_related ?? a?.not_enhancement_related ?? a?.not_form_related ?? [];
