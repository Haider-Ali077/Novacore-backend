// One validation for all six WRICEF types, shared by the server (it blocks the FS) and the page
// (it explains what is missing). No I/O here.
import { fromRgType, rgRelevant, wricefLabel } from "./wricef";

/* eslint-disable @typescript-eslint/no-explicit-any */

const missingValue = (v: unknown) =>
  v == null ||
  (typeof v === "string" && (!v.trim() || /^not (stated|specified)\b/i.test(v.trim()))) ||
  (Array.isArray(v) && v.length === 0);

/**
 * Reports and Workflows: the summary fields their FS cannot be written without. Kept to fields every
 * summary has carried since the start, so older requirements are judged by what they could contain.
 */
const SUMMARY_CHECKS: Record<string, [string, string][]> = {
  R: [["purpose", "Purpose of the report"], ["output_columns", "Output columns"]],
  W: [["business_object", "Business object"], ["trigger_events", "Trigger events"], ["approval_levels", "Approval levels"], ["agent_rules", "Agent determination"], ["outcomes", "Outcomes of approval and rejection"]],
};

/** Mandatory information still missing. RG types report it from the interview; Reports and Workflows are checked here. */
export function mandatoryGaps(wricef: string | null | undefined, summary: any): string[] {
  if (!summary) return [];
  if (fromRgType(wricef)) return ((summary.mandatory_missing as string[] | undefined) ?? []).filter((m) => typeof m === "string" && m.trim());
  return (SUMMARY_CHECKS[wricef ?? "R"] ?? []).filter(([key]) => missingValue(summary[key])).map(([, label]) => label);
}

export type Traceability = {
  /** RG types always tag their requirements; a Report or Workflow FS does from the version that has a Source column on. */
  applicable: boolean;
  total: number;
  sourced: number;
  unsourced: string[];
  /** Rows that come from a default decided without the client (Assumption A-n): traced, but for review. */
  assumedRows: string[];
  /** Places where the FS says the RG is silent: to be answered, never filled in. */
  notSpecified: number;
  /** Defaults the client accepted (A-1, A-2, ...): for review, not confirmed requirements. */
  assumptions: string[];
};

const ROW_ID = /^\|\s*\**((?:FR|BR|TR|V)-\d+)\**\s*\|/;
const HAS_SOURCE = /\(RG\b|\bRG[:\s-]\s*\S|\bClient answers?\b/i;
const FROM_ASSUMPTION = /\bAssumption\s+A-\d+/i;

/** Checks that every requirement, rule and validation row of the FS names the RG or a client answer as its source. */
export function fsTraceability(markdown: string | null | undefined, wricef: string | null | undefined): Traceability {
  const md = markdown ?? "";
  const assumptionSection = md.split(/^## /m).find((s) => /^\d+\.\s*Assumptions/i.test(s)) ?? "";
  const assumptions = [...new Set([...assumptionSection.matchAll(/\bA-\d+\b/g)].map((m) => m[0]))];
  // A Report or Workflow FS written before its tables had a Source column is not judged by this check.
  if (!fromRgType(wricef) && !/^\|.*\|\s*Source\s*\|/im.test(md)) {
    return { applicable: false, total: 0, sourced: 0, unsourced: [], assumedRows: [], notSpecified: 0, assumptions };
  }
  const rows = md.split("\n").map((l) => l.trim()).filter((l) => ROW_ID.test(l));
  const id = (l: string) => l.match(ROW_ID)![1];
  const rest = (l: string) => l.replace(ROW_ID, "|");
  const assumedRows = rows.filter((l) => !HAS_SOURCE.test(rest(l)) && FROM_ASSUMPTION.test(rest(l))).map(id);
  const unsourced = rows.filter((l) => !HAS_SOURCE.test(rest(l)) && !FROM_ASSUMPTION.test(rest(l))).map(id);
  return {
    applicable: true,
    total: rows.length,
    sourced: rows.length - unsourced.length - assumedRows.length,
    unsourced: [...new Set(unsourced)],
    assumedRows: [...new Set(assumedRows)],
    notSpecified: (md.match(/Not specified in the RG/gi) ?? []).length,
    assumptions,
  };
}

/** From this confidence on, an AI classification that disagrees with the selected category blocks the requirement. */
export const CATEGORY_BLOCK_CONFIDENCE = 0.7;

export type CategoryBlock = {
  reason: "mismatch" | "rg_unrelated" | "no_category";
  /** The category the AI found, when it found one of the six. */
  suggested: string | null;
  confidence: number | null;
  explanation: string;
  message: string;
};

/**
 * The RG or requirement does not belong to the selected category. Then nothing more happens in this
 * requirement: no answers, no revisions, no FS and no Modify (enforced in lib/pipeline.ts). The user
 * starts it again in the right category. Never decided by the model alone: these are fixed rules over
 * the classification and the RG analysis.
 */
export function categoryBlock(wricef: string, classification: any, rgAnalysis?: any): CategoryBlock | null {
  const c = classification && !classification.error ? classification : null;
  const label = wricefLabel(wricef);
  const sure = !!c && typeof c.confidence === "number" && c.confidence >= CATEGORY_BLOCK_CONFIDENCE;
  const found = c && c.suggested && !["MIXED", "UNCLEAR"].includes(c.suggested) ? c.suggested : null;
  if (rgAnalysis && fromRgType(wricef) && !rgRelevant(rgAnalysis)) {
    return {
      reason: "rg_unrelated",
      suggested: found && found !== wricef ? found : null,
      confidence: c?.confidence ?? null,
      explanation: rgAnalysis.document_summary ?? "",
      message: `This RG contains no ${label} requirement, so it cannot be processed as a ${label}.`,
    };
  }
  if (!c || !sure) return null;
  if (c.suggested === "UNCLEAR") {
    return { reason: "no_category", suggested: null, confidence: c.confidence, explanation: c.explanation ?? "", message: "This requirement does not fall into any WRICEF category SuperNova supports, so it cannot be processed." };
  }
  if (c.suggested === "MIXED") {
    const parts: string[] = (c.other_parts ?? []).map((p: any) => p.category);
    if (!parts.length || parts.includes(wricef)) return null;
    return { reason: "mismatch", suggested: parts[0], confidence: c.confidence, explanation: c.explanation ?? "", message: `This requirement does not contain a ${label} part, so it cannot be processed as a ${label}.` };
  }
  if (found && found !== wricef) {
    return {
      reason: "mismatch", suggested: found, confidence: c.confidence, explanation: c.explanation ?? "",
      message: `This requirement belongs to ${wricefLabel(found)}, not ${label}, so it cannot be processed as a ${label}.`,
    };
  }
  return null;
}

/**
 * The classification failed, so the category could not be checked: the FS needs the user's confirmation
 * (lib/guardrails.ts fsdPreflight). A disagreeing classification is not confirmable; it blocks (categoryBlock).
 */
export function needsScopeConfirmation(r: { wricef: string; classification?: any }): boolean {
  return !!r.classification?.error;
}

/** Headings that only one category's FS has. One of another category's in an FS means content from that category. */
const SIGNATURE_SECTIONS: Record<string, string[]> = {
  R: ["selectionscreen", "outputcolumns", "datasources"],
  W: ["approvalmatrix", "agentdetermination", "triggerandstartconditions"], // not "processflow": a Report FS may have one too
  I: ["interfaceoverview", "datamapping", "communicationdetails", "errorhandlingandretry"],
  C: ["sourcesystemsandstructures", "targetsapobjectsandstructures", "reconciliationrequirements", "defaultvalues", "datacleansing"],
  E: ["existingsapbehavior", "proposedbehavior", "enhancementoverview", "enhancementrequirements"],
  F: ["formoverviewandtype", "formlayoutandstructure", "fieldlevelspecifications"],
};

/** SAP technical names: TABLE-FIELD, BAPIs, classes and interfaces, custom objects, transaction codes. */
const TECHNICAL = /\b(?:[A-Z][A-Z0-9_]{2,15}-[A-Z][A-Z0-9_]{1,29}|BAPI_[A-Z0-9_]+|CL_[A-Z0-9_]{3,}|IF_[A-Z0-9_]{3,}|Z[A-Z0-9_]{3,29}|[A-Z]{2,4}\d{2,3}[A-Z]?)\b/g;

export type FsdChecks = {
  /** Sections that belong to another WRICEF category's FS. */
  offCategory: string[];
  /** Sections this category's FS must have and this one lacks. */
  missingSections: string[];
  /** Acceptance criteria that name no requirement, rule or validation ID, so they test nothing traceable. */
  unlinkedCriteria: number;
  /** Technical names the FS uses that appear nowhere in the RG, the answers, the summary or (Reports) the catalog. */
  unsupportedClaims: string[];
  /** The FS has no assumptions section, so anything decided without the client is not visible as such. */
  assumptionsMissing: boolean;
};

/** The sections each category's FS cannot do without; the rest of its structure may vary with the RG. */
const REQUIRED_SECTIONS: Record<string, [string, string][]> = {
  R: [["selectionscreen", "Selection screen"], ["datasources", "Data sources"], ["businessrules", "Business rules"], ["outputcolumns", "Output columns"], ["acceptancecriteria", "Acceptance criteria"]],
  W: [["processflow", "Process flow"], ["triggerandstartconditions", "Trigger and start conditions"], ["approvalmatrix", "Approval matrix"], ["agentdetermination", "Agent determination"], ["functionalrequirements", "Functional requirements"], ["exceptionhandling", "Exception handling"], ["acceptancecriteria", "Acceptance criteria"]],
  I: [["interfaceoverview", "Interface overview"], ["dataflow", "Data flow"], ["datamapping", "Data mapping"], ["fielddefinitions", "Field definitions"], ["communicationdetails", "Communication details"], ["errorhandlingandretry", "Error handling and retry"], ["acceptancecriteria", "Acceptance criteria"]],
  C: [["migrationscope", "Migration scope"], ["sourcesystemsandstructures", "Source systems and structures"], ["targetsapobjectsandstructures", "Target SAP objects and structures"], ["fieldmapping", "Field mapping"], ["validationrules", "Validation rules"], ["reconciliationrequirements", "Reconciliation requirements"], ["acceptancecriteria", "Acceptance criteria"]],
  E: [["existingsapbehavior", "Existing SAP behavior"], ["proposedbehavior", "Proposed behavior"], ["enhancementrequirements", "Enhancement requirements"], ["triggeringconditions", "Triggering conditions"], ["validationsandmessages", "Validations and messages"], ["expectedresults", "Expected results"], ["acceptancecriteria", "Acceptance criteria"]],
  F: [["formoverviewandtype", "Form overview and type"], ["formlayoutandstructure", "Form layout and structure"], ["fieldlevelspecifications", "Field-level specifications"], ["datasourceandmappingrequirements", "Data source and mapping requirements"], ["formattingandoutputrequirements", "Formatting and output requirements"], ["acceptancecriteria", "Acceptance criteria"]],
};

/** Checks run on every FS after it is written: content from another category, unbacked technical claims, hidden assumptions. */
export function fsdChecks(markdown: string, wricef: string, corpus: string): FsdChecks {
  const sections = markdown.split(/^## /m).slice(1).map((s) => {
    const title = s.split("\n")[0].replace(/^\d+\.\s*/, "").trim();
    return { title, key: title.toLowerCase().replace(/[^a-z0-9]+/g, "") };
  });
  const own = new Set(SIGNATURE_SECTIONS[wricef] ?? []);
  const others = new Set(Object.entries(SIGNATURE_SECTIONS).filter(([k]) => k !== wricef).flatMap(([, keys]) => keys).filter((k) => !own.has(k)));
  const offCategory = sections.filter((s) => others.has(s.key)).map((s) => s.title);
  const known = corpus.toUpperCase();
  const ids = /^(FR|BR|TR|RG|V|A|Q|G)-?\d+$/;
  const unsupportedClaims = [...new Set(markdown.match(TECHNICAL) ?? [])].filter((t) => !ids.test(t) && !known.includes(t)).slice(0, 25);
  const missingSections = (REQUIRED_SECTIONS[wricef] ?? []).filter(([key]) => !sections.some((s) => s.key === key)).map(([, title]) => title);
  const criteria = (markdown.split(/^## /m).find((s) => /^\d+\.\s*Acceptance criteria/i.test(s)) ?? "")
    .split("\n").slice(1).map((l) => l.trim()).filter((l) => /^(\d+[.)]|[-*])\s+/.test(l));
  const unlinkedCriteria = criteria.filter((l) => !/\b(FR|BR|TR|V)-\d+/.test(l)).length;
  return { offCategory, missingSections, unlinkedCriteria, unsupportedClaims, assumptionsMissing: !sections.some((s) => s.key.startsWith("assumption")) };
}
