// The agents: each one is a prompt file + an output schema + one callLLM call.
import { callLLM, type ChatMessage } from "./llm";
import { loadPrompt } from "./prompts";
import { catalog, catalogForPrompt } from "./catalog";
import type { CheckIssue } from "./checks";
import type { SectionChange } from "./fsd";
import { wricefLabel, type Wricef } from "./wricef";

export const MAX_QUESTIONS = 7; // 3 to 5 questions, and up to 2 follow-ups for contradictions and gaps
export const MIN_QUESTIONS = 3;

// ---------------------------------------------------------------- Interviewer
export type InterviewTurn = {
  /** The latest client message asked about another category or an unrelated topic; see lib/guardrails.ts. */
  out_of_scope?: boolean;
  out_of_scope_topic?: string;
  status: "questions" | "complete";
  message: string;
  questions: string[];
  summary: Record<string, unknown> | null;
  coverage?: { topic: string; state: "answered" | "assumed" | "open" }[];
  contradictions?: string[];
};

const interviewSchema = {
  type: "object",
  required: ["status", "message", "questions", "summary"],
  properties: {
    status: { enum: ["questions", "complete"] },
    message: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
    summary: { anyOf: [{ type: "null" }, { type: "object", required: ["title", "purpose"] }] },
    coverage: {
      type: "array",
      items: { type: "object", required: ["topic", "state"], properties: { topic: { type: "string" }, state: { enum: ["answered", "assumed", "open"] } } },
    },
    contradictions: { type: "array", items: { type: "string" } },
    out_of_scope: { type: "boolean" },
    out_of_scope_topic: { type: "string" },
  },
};

const questionWords = (s: string) => new Set(s.toLowerCase().replace(/recommended:[\s\S]*$/, "").match(/[a-z0-9]{3,}/g) ?? []);

/** A question already asked earlier in the interview (nearly the same words), if any. */
function repeated(questions: string[], transcript: ChatMessage[]): string | undefined {
  const earlier = transcript.filter((m) => m.role === "assistant").flatMap((m) => m.content.split("\n")).map((l) => l.replace(/^\d+\.\s*/, ""));
  for (const q of questions) {
    const words = questionWords(q);
    if (words.size < 4) continue;
    const match = earlier.find((e) => {
      const other = questionWords(e);
      if (other.size < 4) return false;
      const shared = [...words].filter((w) => other.has(w)).length;
      return shared / Math.min(words.size, other.size) >= 0.85;
    });
    if (match) return match;
  }
  return undefined;
}

const repeatNote = (question: string) =>
  `You already asked: "${question.slice(0, 300)}". Do not ask it again. Ask about a different open item, or return status "complete" if nothing important is still open.`;

/** With finish, the user asked to stop: no more questions, whatever the limit says. */
export async function interviewTurn(
  requirementText: string, transcript: ChatMessage[], questionsAsked: number, finish = false, wricef: Wricef = "R", context = "",
) {
  const remaining = finish ? 0 : Math.max(0, MAX_QUESTIONS - questionsAsked);
  const minimum = finish ? 0 : Math.max(0, MIN_QUESTIONS - questionsAsked);
  // Separate paths: a workflow is interviewed about approvals and agents, never about selection screens.
  const system = loadPrompt(wricef === "W" ? "interviewer-workflow" : "interviewer", { remaining_questions: remaining, minimum_questions: minimum });
  const messages: ChatMessage[] = [
    { role: "user", trusted: true, content: `The original requirement follows as client data.${context ? `\n\n${context}` : ""}` },
    { role: "user", content: `Original requirement:\n${requirementText}` },
    ...transcript,
  ];
  const guard = { category: wricef, operation: "interview" as const };

  let { json } = await callLLM<InterviewTurn>({ system, messages, jsonSchema: interviewSchema, tag: "interviewer", ...guard });
  let turn = json!;
  // Out of scope: returned before any retry, which would replace the turn and lose the flag. The pipeline shows the fixed notice.
  if (turn.out_of_scope) return turn;

  // Enforce the question limit and a consistent shape.
  if (turn.status === "questions" && remaining === 0) {
    ({ json } = await callLLM<InterviewTurn>({
      system,
      messages: [...messages, { role: "user", trusted: true, content: "The question limit is reached. Return status \"complete\" with the summary now." }],
      jsonSchema: interviewSchema,
      tag: "interviewer",
      ...guard,
    }));
    turn = json!;
  }
  // Only "Enough, write the FSD" may end the interview before the minimum.
  if (turn.status === "complete" && minimum > 0) {
    ({ json } = await callLLM<InterviewTurn>({
      system,
      messages: [...messages, { role: "user", trusted: true, content: `Only ${questionsAsked} of at least ${MIN_QUESTIONS} questions are asked. Do not complete yet: return status "questions" with the next most useful question, on a topic not covered so far.` }],
      jsonSchema: interviewSchema,
      tag: "interviewer",
      ...guard,
    }));
    turn = json!;
  }
  // Never the same question twice: checked here, not only asked of the model.
  const again = turn.status === "questions" ? repeated(turn.questions, transcript) : undefined;
  if (again) {
    ({ json } = await callLLM<InterviewTurn>({
      system,
      messages: [...messages, { role: "user", trusted: true, content: repeatNote(again) }],
      jsonSchema: interviewSchema,
      tag: "interviewer",
      ...guard,
    }));
    turn = json!;
  }
  if (turn.status === "questions") turn.questions = turn.questions.slice(0, 1); // one at a time, even if the model sends more
  if (turn.status === "complete" && !turn.summary) throw new Error("Interviewer returned status complete without a summary.");
  return turn;
}

// ------------------ RG types: Interfaces (I), Conversions (C), Forms (F), Enhancements (E)
// All start from the client's RG and share one flow: the RG Analyst reads it, the interviewer closes
// the gaps, the FS is written from the RG plus the confirmed requirement. Only the prompts and the
// name of the analysis' subject list differ per type.
export const RG_MAX_QUESTIONS = 15; // asked in groups of up to 3; no minimum, because the RG may already settle everything

type RgType = "F" | "E" | "I" | "C";
const RG_PROMPTS: Record<RgType, { analyst: string; interviewer: string; fsd: string; subjects: string; relevant: string; unrelated: string; subjectFields: string[] }> = {
  F: {
    analyst: "rg-analyst", interviewer: "interviewer-form", fsd: "fsd-form",
    subjects: "forms", relevant: "is_forms_rg", unrelated: "not_form_related", subjectFields: ["name", "business_document", "technology", "rg_reference"],
  },
  E: {
    analyst: "rg-analyst-enhancement", interviewer: "interviewer-enhancement", fsd: "fsd-enhancement",
    subjects: "enhancements", relevant: "is_enhancement_rg", unrelated: "not_enhancement_related", subjectFields: ["name", "enhancement_type", "sap_process", "rg_reference"],
  },
  I: {
    analyst: "rg-analyst-interface", interviewer: "interviewer-interface", fsd: "fsd-interface",
    subjects: "interfaces", relevant: "is_interface_rg", unrelated: "not_interface_related",
    subjectFields: ["name", "interface_type", "direction", "source_system", "target_system", "rg_reference"],
  },
  C: {
    analyst: "rg-analyst-conversion", interviewer: "interviewer-conversion", fsd: "fsd-conversion",
    subjects: "conversions", relevant: "is_conversion_rg", unrelated: "not_conversion_related",
    subjectFields: ["name", "data_category", "source_system", "target_object", "rg_reference"],
  },
};
const rgType = (w: Wricef): RgType => (w === "E" || w === "I" || w === "C" ? w : "F");

const AREA = { type: "string" };
/** What the RG Analyst read: "forms", "enhancements", "interfaces" or "conversions" by type; see rgSubjects in lib/wricef.ts. */
export type RgAnalysis = {
  document_summary: string;
  requirements: { id: string; area: string; text: string; rg_reference: string }[];
  gaps: { id: string; area: string; kind: "missing" | "unclear" | "conflict"; description: string; mandatory: boolean }[];
  is_forms_rg?: boolean;
  forms?: { name: string; business_document: string; technology: string; rg_reference: string }[];
  not_form_related?: string[];
  is_enhancement_rg?: boolean;
  enhancements?: { name: string; enhancement_type: string; sap_process: string; rg_reference: string }[];
  not_enhancement_related?: string[];
  is_interface_rg?: boolean;
  interfaces?: { name: string; interface_type: string; direction: string; source_system: string; target_system: string; rg_reference: string }[];
  not_interface_related?: string[];
  is_conversion_rg?: boolean;
  conversions?: { name: string; data_category: string; source_system: string; target_object: string; rg_reference: string }[];
  not_conversion_related?: string[];
};

function rgAnalysisSchema(t: RgType) {
  const c = RG_PROMPTS[t];
  const strings = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, { type: "string" }]));
  return {
    type: "object",
    required: [c.relevant, "document_summary", c.subjects, "requirements", "gaps", c.unrelated],
    properties: {
      [c.relevant]: { type: "boolean" },
      document_summary: { type: "string" },
      [c.subjects]: { type: "array", items: { type: "object", required: c.subjectFields, properties: strings(c.subjectFields) } },
      requirements: {
        type: "array",
        items: { type: "object", required: ["id", "area", "text", "rg_reference"], properties: { id: { type: "string" }, area: AREA, text: { type: "string" }, rg_reference: { type: "string" } } },
      },
      gaps: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "area", "kind", "description", "mandatory"],
          properties: { id: { type: "string" }, area: AREA, kind: { enum: ["missing", "unclear", "conflict"] }, description: { type: "string" }, mandatory: { type: "boolean" } },
        },
      },
      [c.unrelated]: { type: "array", items: { type: "string" } },
    },
  };
}

const rgMessage = (filename: string, rgText: string) => `RG document "${filename}":\n\n${rgText}`;

/** Reads the whole RG once and lists what it says for this type, and what it leaves open. */
export async function analyzeRg(filename: string, rgText: string, wricef: Wricef = "F"): Promise<RgAnalysis> {
  const t = rgType(wricef);
  const { json } = await callLLM<RgAnalysis>({
    system: loadPrompt(RG_PROMPTS[t].analyst),
    messages: [{ role: "user", content: rgMessage(filename, rgText) }],
    jsonSchema: rgAnalysisSchema(t),
    tag: RG_PROMPTS[t].analyst,
    category: wricef,
    operation: "rg_analysis",
  });
  return json!;
}

export type TrackedItem = { id: string; area: string; text: string; status: "confirmed" | "open" | "conflict"; source: "RG" | "Answer"; mandatory: boolean };
export type RgInterviewTurn = InterviewTurn & { group?: string; tracked?: TrackedItem[]; mandatory_missing?: string[] };

const rgInterviewSchema = {
  ...interviewSchema,
  properties: {
    ...interviewSchema.properties,
    group: { type: "string" },
    questions: { type: "array", items: { type: "string" }, maxItems: 3 },
    tracked: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "area", "text", "status", "source", "mandatory"],
        properties: {
          id: { type: "string" }, area: AREA, text: { type: "string" }, status: { enum: ["confirmed", "open", "conflict"] },
          source: { enum: ["RG", "Answer"] }, mandatory: { type: "boolean" },
        },
      },
    },
    mandatory_missing: { type: "array", items: { type: "string" } },
  },
};

/** One clarification turn for an RG. The RG and its analysis open every conversation, so nothing it settles is asked again. */
export async function rgInterviewTurn(
  rg: { filename: string; text: string; analysis: RgAnalysis }, transcript: ChatMessage[], questionsAsked: number, finish = false, wricef: Wricef = "F",
) {
  const prompt = RG_PROMPTS[rgType(wricef)].interviewer;
  const remaining = finish ? 0 : Math.max(0, RG_MAX_QUESTIONS - questionsAsked);
  const system = loadPrompt(prompt, { remaining_questions: remaining });
  const opening = `${rgMessage(rg.filename, rg.text)}\n\nRG Analyst's reading of it:\n${JSON.stringify(rg.analysis, null, 2)}`;
  const messages: ChatMessage[] = [{ role: "user", content: opening }, ...transcript];

  const guard = { category: wricef, operation: "interview" as const };
  let { json } = await callLLM<RgInterviewTurn>({ system, messages, jsonSchema: rgInterviewSchema, tag: prompt, ...guard });
  let turn = json!;
  // Out of scope: returned before any retry, which would replace the turn and lose the flag. The pipeline shows the fixed notice.
  if (turn.out_of_scope) return turn;
  if (turn.status === "questions" && remaining === 0) {
    ({ json } = await callLLM<RgInterviewTurn>({
      system,
      messages: [...messages, { role: "user", trusted: true, content: "The question limit is reached. Return status \"complete\" with the summary now, listing everything still open." }],
      jsonSchema: rgInterviewSchema,
      tag: prompt,
      ...guard,
    }));
    turn = json!;
  }
  const again = turn.status === "questions" ? repeated(turn.questions, transcript) : undefined;
  if (again) {
    ({ json } = await callLLM<RgInterviewTurn>({
      system,
      messages: [...messages, { role: "user", trusted: true, content: repeatNote(again) }],
      jsonSchema: rgInterviewSchema,
      tag: prompt,
      ...guard,
    }));
    turn = json!;
  }
  if (turn.status === "questions") turn.questions = turn.questions.slice(0, Math.min(3, remaining));
  if (turn.status === "complete" && !turn.summary) throw new Error("Interviewer returned status complete without a summary.");
  return turn;
}

// --------------------------------------------------------------- Classifier
export type Classification = {
  suggested: "R" | "W" | "I" | "C" | "E" | "F" | "MIXED" | "UNCLEAR";
  confidence: number;
  explanation: string;
  other_parts: { category: string; reason: string }[];
};

const classificationSchema = {
  type: "object",
  required: ["suggested", "confidence", "explanation", "other_parts"],
  properties: {
    suggested: { enum: ["R", "W", "I", "C", "E", "F", "MIXED", "UNCLEAR"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    explanation: { type: "string" },
    other_parts: { type: "array", items: { type: "object", required: ["category", "reason"], properties: { category: { type: "string" }, reason: { type: "string" } } } },
  },
};

/**
 * The AI's own reading of the WRICEF category. Advice only: it never changes the user's choice, and it
 * is not told that choice, so the suggestion is not steered by it.
 */
export async function classifyRequirement(text: string, selected: Wricef): Promise<Classification> {
  const { json } = await callLLM<Classification>({
    system: loadPrompt("classifier"),
    messages: [{ role: "user", content: `Requirement:\n${text}` }],
    jsonSchema: classificationSchema,
    tag: "classifier",
    category: selected,
    operation: "classification",
  });
  return json!;
}

// -------------------------------------------------------------- FSD Generator
export async function generateFsd(
  summary: unknown, requirementText: string, wricef: Wricef = "R", rg?: { filename: string; text: string; analysis: RgAnalysis | null },
): Promise<string> {
  if (wricef === "F" || wricef === "E" || wricef === "I" || wricef === "C") {
    // Written from the RG itself as well as the confirmed requirement, so every statement can be traced back.
    const prompt = RG_PROMPTS[wricef].fsd;
    const { text } = await callLLM({
      system: loadPrompt(prompt),
      messages: [
        {
          role: "user",
          content: `${rgMessage(rg?.filename ?? "RG", rg?.text ?? requirementText)}\n\nRG Analyst's reading of it:\n${JSON.stringify(rg?.analysis ?? null, null, 2)}\n\nRequirement confirmed by the client after clarification:\n${JSON.stringify(summary, null, 2)}`,
        },
      ],
      tag: prompt,
      category: wricef,
      operation: "fsd_generation",
    });
    return text.trim() + "\n";
  }
  const system = wricef === "W" ? loadPrompt("fsd-workflow") : loadPrompt("fsd", { catalog: catalogForPrompt() });
  const { text } = await callLLM({
    system,
    messages: [
      {
        role: "user",
        content: `Original requirement:\n${requirementText}\n\nStructured requirement summary from the interview:\n${JSON.stringify(summary, null, 2)}`,
      },
    ],
    tag: wricef === "W" ? "fsd-workflow" : "fsd",
    category: wricef,
    operation: "fsd_generation",
  });
  return text.trim() + "\n";
}

/** The TS is written from the approved FS, never from the interview alone. */
export async function generateTs(fsMarkdown: string, summary: unknown, wricef: Wricef, fsLabel: string): Promise<string> {
  const system = wricef === "W"
    ? loadPrompt("ts-workflow", { fs_version: fsLabel })
    : loadPrompt("ts-report", { fs_version: fsLabel, catalog: catalogForPrompt() });
  const { text } = await callLLM({
    system,
    messages: [{ role: "user", content: `Approved FS (version ${fsLabel}):\n\n${fsMarkdown}\n\nRequirement summary from the interview:\n${JSON.stringify(summary, null, 2)}` }],
    tag: wricef === "W" ? "ts-workflow" : "ts-report",
    category: wricef,
    operation: "ts_generation",
  });
  return text.trim() + "\n";
}

// ------------------------------------------------------------------ Modify FSD
export type FsdChangePlan = {
  out_of_scope?: boolean;
  out_of_scope_topic?: string;
  understood: string;
  explanation: string;
  affected_sections: { heading: string; why: string }[];
  new_sections: string[];
  change_type: "minor" | "major";
};

/** The plan schema as it always was; a TS change still uses exactly this. */
const tsPlanSchema = {
  type: "object",
  required: ["understood", "explanation", "affected_sections", "new_sections", "change_type"],
  properties: {
    understood: { type: "string", minLength: 1 },
    explanation: { type: "string", minLength: 1 },
    affected_sections: {
      type: "array",
      items: { type: "object", required: ["heading", "why"], properties: { heading: { type: "string" }, why: { type: "string" } } },
    },
    new_sections: { type: "array", items: { type: "string" } },
    change_type: { enum: ["minor", "major"] },
  },
};
/** An FS change can also be flagged out of scope for the category. */
const planSchema = {
  ...tsPlanSchema,
  properties: { ...tsPlanSchema.properties, out_of_scope: { type: "boolean" }, out_of_scope_topic: { type: "string" } },
};

const applySchema = {
  type: "object",
  required: ["summary", "sections"],
  properties: {
    summary: { type: "string", minLength: 1 },
    sections: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["heading", "action", "markdown"],
        properties: { heading: { type: "string", minLength: 1 }, action: { enum: ["replace", "add", "remove"] }, markdown: { type: "string" } },
      },
    },
  },
};

const fsdContext = (markdown: string, docType = "FS"): ChatMessage => ({
  role: "user",
  content: `Current ${docType === "TS" ? "Technical Specification (TS)" : "Functional Specification (FS)"}:\n\n${markdown}`,
});

export async function planFsdChange(markdown: string, conversation: ChatMessage[], docType = "FS", wricef: Wricef = "R"): Promise<FsdChangePlan> {
  const { json } = await callLLM<FsdChangePlan>({
    system: loadPrompt("fsd-plan", { catalog: catalogForPrompt() }),
    messages: [fsdContext(markdown, docType), ...conversation],
    jsonSchema: docType === "TS" ? tsPlanSchema : planSchema,
    tag: "fsd-plan",
    category: wricef,
    operation: docType === "TS" ? "ts_generation" : "change_analysis",
  });
  return json!;
}

export async function applyFsdChangePlan(markdown: string, conversation: ChatMessage[], plan: FsdChangePlan, docType = "FS", wricef: Wricef = "R") {
  const { json } = await callLLM<{ summary: string; sections: SectionChange[] }>({
    system: loadPrompt("fsd-apply", { catalog: catalogForPrompt() }),
    messages:
      docType === "TS"
        ? [fsdContext(markdown, docType), ...conversation, { role: "user", content: `Confirmed. Apply this plan:\n${JSON.stringify(plan)}` }]
        : [
            fsdContext(markdown, docType),
            ...conversation,
            { role: "user", trusted: true, content: "The client confirmed the change. Apply the plan in the next message." },
            { role: "user", content: `Plan:\n${JSON.stringify(plan)}` },
          ],
    jsonSchema: applySchema,
    tag: "fsd-apply",
    category: wricef,
    operation: docType === "TS" ? "ts_generation" : "change_apply",
  });
  return json!;
}

// ------------------------------------------------------------------ Dev Agent
export type GeneratedProgram = {
  program_name: string;
  title: string;
  abap_source: string;
  selection_texts: { key: string; text: string }[];
  /** PROG (an executable program; every Report) or CLAS (a global class). Missing means PROG. */
  object_type?: "PROG" | "CLAS";
  /** The WRICEF category the object was generated for. Missing means R. */
  wricef?: string;
  /** What has to be created in SAP by hand around the generated object (layout, template, BAdI implementation...). */
  manual_steps?: string[];
};

const programSchema = {
  type: "object",
  required: ["program_name", "title", "abap_source", "selection_texts"],
  properties: {
    program_name: { type: "string", pattern: "^[ZYzy][A-Za-z0-9_]{1,29}$" },
    title: { type: "string", minLength: 1, maxLength: 70 },
    abap_source: { type: "string", minLength: 20 },
    selection_texts: {
      type: "array",
      items: {
        type: "object",
        required: ["key", "text"],
        properties: { key: { type: "string", maxLength: 8 }, text: { type: "string", maxLength: 30 } },
      },
    },
  },
};

function devPrompt() {
  return loadPrompt("dev", { catalog: catalogForPrompt(), abap_version: process.env.ABAP_VERSION || "v757" });
}

/**
 * Fixes slips that have exactly one correct form, so they never reach the checks or cost a repair pass:
 *  - An indented `*` line is not a comment in ABAP. It glues onto the next statement, and the colon of
 *    "* FR-01: ..." turns that statement into a chain, so one line gives one parser error per comma.
 *  - CALL TRANSACTION takes WITH AUTHORITY-CHECK before AND SKIP FIRST SCREEN.
 *  - DATA( ) is for inline declarations; with an explicit TYPE it has to be a plain DATA.
 *  - ( @s_x IS INITIAL OR f IN @s_x ) is invalid, and f IN @s_x alone already means the same.
 *  - A field list INTO TABLE fills by position, so a full-row target needs CORRESPONDING.
 *  - LOOP ... WHERE cannot call line_exists( ), so the test moves to a CHECK inside the loop.
 *  - FIELD-SYMBOL(<x>) may declare <x> only once per FORM or METHOD.
 *  - DATA inside a loop is set up once, not once per pass, so a counter needs a CLEAR to restart.
 *  - TITLE t_b1 and COMMENT ... c_x declare those names themselves, so a DATA for them clashes.
 */
export function cleanAbap(src: string): string {
  let inStatement = false;
  const lines = src.split("\n").map((line) => {
    const code = line.trimStart();
    if (code === "" || code.startsWith('"')) return line;
    // Inside a statement a leading * is a multiplication, unless it is clearly one of our comments.
    if (code.startsWith("*")) return !inStatement || /^\*\s*(FR-\d|NOTE\b)/.test(code) ? code : line;
    inStatement = !/[.,:]$/.test(code.replace(/\s*".*$/, "").trimEnd());
    return line;
  });
  let text = lines
    .join("\n")
    .replace(/(CALL\s+TRANSACTION\s+\S+)\s+(AND\s+SKIP\s+FIRST\s+SCREEN)\s+(WITH(?:OUT)?\s+AUTHORITY-CHECK)/gi, "$1 $3 $2")
    .replace(/^(\s*DATA)\(\s*(\w+)\s*\)(\s+TYPE\b)/gim, "$1 $2$3")
    .replace(/\(\s*@(s_\w+)\s+IS\s+INITIAL\s+OR\s+([\w~]+\s+IN\s+@\1)\s*\)/gi, "$2")
    .replace(/^([ \t]*)(LOOP\s+AT\b[^.]*?)\s+AND\s+((?:NOT\s+)?line_exists\([^.]*?\))\s*\./gim, "$1$2.\n$1  CHECK $3.")
    // m( a = b CHANGING c = d ): once a call has another parameter list, the first one needs its EXPORTING.
    // Stops at a quote or period, so text literals and other statements are never touched.
    .replace(/([\w/~]+\(\s*)(?!(?:EXPORTING|IMPORTING|CHANGING|RECEIVING|EXCEPTIONS)\b)(\w+\s*=(?!=)[^.'`]*?\b(?:CHANGING|IMPORTING|RECEIVING|EXCEPTIONS)\b)/gi, "$1EXPORTING $2");
  text = dropScreenNames(resetLoopLocals(declareFieldSymbolsOnce(text)));
  for (const m of text.matchAll(/\b(\w+)\s+TYPE\s+(?:(?:STANDARD|SORTED|HASHED)\s+)?TABLE\s+OF\s+([\w/]+)(?![\w/-])/gi)) {
    if (!catalog().tables[m[2].toUpperCase()]) continue;
    text = text.replace(new RegExp(String.raw`\bINTO\s+TABLE\s+@${m[1]}\b`, "gi"), `INTO CORRESPONDING FIELDS OF TABLE @${m[1]}`);
  }
  return text;
}

function declareFieldSymbolsOnce(text: string): string {
  return text
    .split(/^(?=[ \t]*(?:FORM|METHOD)\s)/im)
    .map((block) => {
      const seen = new Set<string>();
      for (const list of block.matchAll(/\bFIELD-SYMBOLS\b[^.]*\./gi)) {
        for (const name of list[0].matchAll(/<\w+>/g)) seen.add(name[0].toLowerCase());
      }
      return block.replace(/FIELD-SYMBOL\(\s*(<\w+>)\s*\)/gi, (whole, name: string) => {
        if (seen.has(name.toLowerCase())) return name;
        seen.add(name.toLowerCase());
        return whole;
      });
    })
    .join("");
}

function dropScreenNames(text: string): string {
  const declared = [...text.matchAll(/\bTITLE\s+(\w+)/gi), ...text.matchAll(/\bCOMMENT\s+\/?\d*\(\d+\)\s+(\w+)/gi)];
  const names = new Set(declared.map((m) => m[1].toLowerCase()));
  return text.replace(/^[ \t]*DATA\s*:?\s*[^.]*\.[ \t]*\n/gim, (statement) => {
    const parts = statement.replace(/^[ \t]*DATA\s*:?\s*/i, "").replace(/\.\s*$/, "").split(",");
    const kept = parts.filter((p) => !names.has(p.trim().split(/\s+/)[0].toLowerCase()));
    if (kept.length === parts.length) return statement;
    return kept.length ? `DATA: ${kept.map((p) => p.trim()).join(",\n      ")}.\n` : "";
  });
}

function resetLoopLocals(text: string): string {
  let depth = 0;
  return text
    .split("\n")
    .flatMap((line, i, lines) => {
      if (/^\s*(LOOP\s+AT|DO\b|WHILE\b)/i.test(line)) depth++;
      else if (/^\s*(ENDLOOP|ENDDO|ENDWHILE)\b/i.test(line)) depth--;
      const local = depth > 0 && line.match(/^(\s*)DATA\s+(\w+)\s+TYPE\s+[^.:,]*?(?:\s+VALUE\s+(?:0|''|' '|``))?\s*\.\s*$/i);
      if (!local || /\bVALUE\b/i.test(line.replace(/\s+VALUE\s+(0|''|' '|``)\s*\.\s*$/i, "."))) return [line];
      const clear = `${local[1]}CLEAR ${local[2]}.`;
      return lines[i + 1]?.trim().toLowerCase() === clear.trim().toLowerCase() ? [line] : [line, clear];
    })
    .join("\n");
}

function normalizeProgram(p: GeneratedProgram): GeneratedProgram {
  return {
    program_name: p.program_name.toUpperCase(),
    title: p.title.trim(),
    abap_source: cleanAbap(p.abap_source.replace(/\r\n/g, "\n")),
    selection_texts: p.selection_texts.map((s) => ({ key: s.key.toUpperCase(), text: s.text.trim() })),
    ...(p.object_type ? { object_type: p.object_type } : {}),
    ...(p.manual_steps ? { manual_steps: p.manual_steps.map((m) => m.trim()).filter(Boolean) } : {}),
  };
}

/** The other five categories: a program or class of the kind that category needs, plus the manual steps around it. */
const categoryProgramSchema = {
  type: "object",
  required: ["object_type", "program_name", "title", "abap_source", "selection_texts", "manual_steps"],
  properties: {
    ...programSchema.properties,
    object_type: { enum: ["PROG", "CLAS"] },
    manual_steps: { type: "array", items: { type: "string" } },
  },
};

const DEV_PROMPTS: Record<string, string> = { W: "dev-workflow", I: "dev-interface", C: "dev-conversion", E: "dev-enhancement", F: "dev-form" };

/** dev-common.md (shared rules and output) followed by the category's own guidance. */
function categoryDevPrompt(wricef: Wricef) {
  const vars = { catalog: catalogForPrompt(), abap_version: process.env.ABAP_VERSION || "v757", category_label: wricefLabel(wricef) };
  return `${loadPrompt("dev-common", vars)}\n\n${loadPrompt(DEV_PROMPTS[wricef], vars)}`;
}

/** ABAP for a Workflow, Interface, Conversion, Enhancement or Form, from its approved FS. Reports use generateAbap. */
export async function generateCategoryAbap(wricef: Wricef, fsMarkdown: string): Promise<GeneratedProgram> {
  if (!DEV_PROMPTS[wricef]) throw new Error(`No code generator for category ${wricef}.`);
  const { json } = await callLLM<GeneratedProgram>({
    system: categoryDevPrompt(wricef),
    messages: [{ role: "user", content: `Approved FS:\n\n${fsMarkdown}` }],
    jsonSchema: categoryProgramSchema,
    tag: DEV_PROMPTS[wricef],
    category: wricef,
    operation: "code_generation",
  });
  return { ...normalizeProgram(json!), wricef };
}

export async function generateAbap(fsdMarkdown: string, tsMarkdown?: string): Promise<GeneratedProgram> {
  const ts = tsMarkdown ? `\n\nApproved Technical Specification (TS):\n\n${tsMarkdown}` : "";
  const { json } = await callLLM<GeneratedProgram>({
    system: devPrompt(),
    messages: [{ role: "user", content: `Approved FSD:\n\n${fsdMarkdown}${ts}` }],
    jsonSchema: programSchema,
    tag: "dev",
    category: "R",
    operation: "code_generation",
  });
  return normalizeProgram(json!);
}

export async function repairAbap(fsdMarkdown: string, program: GeneratedProgram, errors: CheckIssue[], wricef: Wricef = "R"): Promise<GeneratedProgram> {
  // Quote the offending line: a parser error alone ("go_alv") does not say what to change.
  const lines = program.abap_source.split("\n");
  const errorList = errors
    .map((e) => {
      const src = e.line ? lines[e.line - 1]?.trim() : "";
      return `- [${e.rule}]${e.line ? ` line ${e.line}` : ""}: ${e.message}${src ? `\n    source: ${src}` : ""}`;
    })
    .join("\n");
  // A Report is repaired exactly as before; the other categories with their own rules and output format.
  const report = wricef === "R";
  const sent = report ? program : { ...program, wricef: undefined };
  const { json } = await callLLM<GeneratedProgram>({
    system: loadPrompt("repair", { dev_rules: report ? devPrompt() : categoryDevPrompt(wricef) }),
    messages: [
      {
        role: "user",
        content: `Approved FSD:\n\n${fsdMarkdown}\n\nProgram you generated (JSON):\n${JSON.stringify(sent)}\n\nErrors from the rule-based checks:\n${errorList}`,
      },
    ],
    jsonSchema: report ? programSchema : categoryProgramSchema,
    tag: "repair",
    category: wricef,
    operation: "code_repair",
  });
  const repaired = normalizeProgram(json!);
  return report ? repaired : { ...repaired, object_type: repaired.object_type ?? program.object_type, manual_steps: repaired.manual_steps ?? program.manual_steps, wricef };
}

// ---------------------------------------------------------------- Code Review
export type ReviewResult = {
  summary: string;
  findings: { severity: "high" | "medium" | "low"; line: number; title: string; detail: string; suggestion: string }[];
};

const reviewSchema = {
  type: "object",
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "line", "title", "detail", "suggestion"],
        properties: { severity: { enum: ["high", "medium", "low"] }, line: { type: "number" } },
      },
    },
  },
};

export async function reviewCode(fsdMarkdown: string, source: string, ruleIssues: CheckIssue[]): Promise<ReviewResult> {
  const numbered = source
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(4)}  ${l}`)
    .join("\n");
  const known = ruleIssues.length ? ruleIssues.map((e) => `- [${e.rule}] ${e.message}`).join("\n") : "(none)";
  const { json } = await callLLM<ReviewResult>({
    system: loadPrompt("review"),
    messages: [
      {
        role: "user",
        content: `Approved FSD:\n\n${fsdMarkdown}\n\nIssues already reported by the rule-based checks:\n${known}\n\nABAP source with line numbers:\n${numbered}`,
      },
    ],
    jsonSchema: reviewSchema,
    tag: "review",
    category: "R",
    operation: "code_review",
  });
  return json!;
}
