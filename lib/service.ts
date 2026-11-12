// The backend engine's single entry point for actions. The SuperNova page (app/api/pipeline) and the
// external API (app/api/v1) both call performAction, so there is one implementation of every step: the
// WRICEF flows, guardrails, FS/TS versions, approvals, ABAP generation and export all live in lib/.
import {
  addFsdComment, applyFsdChange, approveFsd, changeWricef, classifyStep, createLinkedPair, createRequirement, discardFsdChange, exportStep,
  generateCodeStep, generateFsdStep, generateTsStep, interviewStep, proposeFsdChange, reviewStep, reviseAnswer, saveFsdEdit,
  setQuestionResolved, setRequirementClient, startAs, startInterview, StepError, type DocType,
} from "./pipeline";
import { readRgs, type RgUpload } from "./rg";
import { CHOICES } from "./wricef";

export type ActionInput = {
  text?: string;
  fsdVersionId?: number;
  force?: boolean;
  summary?: string;
  changeId?: number;
  changeType?: "MINOR" | "MAJOR";
  section?: string;
  resolved?: boolean;
  client?: { name?: string; logo?: string; logoType?: string };
  choice?: string;
  project?: string;
  docType?: DocType;
  wricef?: string;
  confirmed?: boolean;
  /** The user confirmed the selected category against a failed AI classification. */
  scopeConfirmed?: boolean;
  /** One RG as a base64 file or pasted text (the single-file form, still accepted). */
  rg?: RgUpload;
  /** Any number of attachments, each a base64 file, for every WRICEF type. */
  rgs?: RgUpload[];
  /** Pasted RG text for the types that start from an RG. */
  rgText?: string;
};

export const ACTIONS = [
  "start", "startAs", "classify", "reviseAnswer", "changeWricef", "generateTs", "answer", "setClient", "finishInterview", "generateFsd",
  "saveFsd", "proposeChange", "applyChange", "discardChange", "addComment", "resolveQuestion", "approve", "generateCode", "review", "export",
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * Runs one action on ctx.id and returns the requirement it concerns. start and startAs set ctx.id to the new
 * requirement as soon as it exists, so a caller still knows it when a later part of the action fails.
 * Errors are thrown as they are (StepError, LlmError, RgError); each caller gives them its own format.
 */
export async function performAction(action: string, ctx: { id: number | null }, input: ActionInput): Promise<number | null> {
  let id = ctx.id;
  switch (action) {
    case "start": {
      const fromRg = !!CHOICES.find((c) => c.id === input.choice)?.fromRg;
      const uploads = [...(input.rgs ?? []), ...(input.rg?.data ? [input.rg] : [])];
      const pasted = input.rgText ?? (input.rg && !input.rg.data ? input.rg.text : "") ?? "";
      const rgs = await readRgs(uploads, fromRg ? pasted : "");
      if (input.choice === "mixed") {
        const pair = createLinkedPair(input.text ?? "", input.client, input.project, rgs);
        id = ctx.id = pair.report;
        await classifyStep(pair.workflow);
      } else {
        id = ctx.id = createRequirement(fromRg ? "" : input.text ?? "", input.client, { choice: input.choice, project: input.project }, rgs);
      }
      await classifyStep(id);
      // A requirement whose RG belongs to another category stops here; the caller shows the AI's result.
      await startInterview(id);
      break;
    }
    case "startAs":
      id = ctx.id = await startAs(need(id), input.wricef ?? "");
      break;
    case "classify":
      await classifyStep(need(id));
      break;
    case "reviseAnswer":
      await reviseAnswer(need(id), input.text ?? "");
      break;
    case "changeWricef":
      await changeWricef(need(id), input.wricef ?? "", !!input.confirmed);
      break;
    case "generateTs":
      await generateTsStep(need(id));
      break;
    case "answer":
      await interviewStep(need(id), input.text);
      break;
    case "setClient":
      setRequirementClient(need(id), input.client ?? {});
      break;
    case "finishInterview":
      await interviewStep(need(id), input.text, true);
      break;
    case "generateFsd":
      await generateFsdStep(need(id), !!input.confirmed, !!input.scopeConfirmed);
      break;
    case "saveFsd":
      saveFsdEdit(need(id), input.text ?? "", input.summary, input.docType);
      break;
    case "proposeChange":
      await proposeFsdChange(need(id), input.text, input.fsdVersionId, input.changeId, input.docType);
      break;
    case "applyChange":
      await applyFsdChange(need(id), input.changeId ?? 0, input.changeType);
      break;
    case "discardChange":
      discardFsdChange(need(id), input.changeId ?? 0);
      break;
    case "addComment":
      addFsdComment(need(id), input.fsdVersionId ?? 0, input.section ?? "", input.text ?? "");
      break;
    case "resolveQuestion":
      setQuestionResolved(need(id), input.fsdVersionId ?? 0, input.text ?? "", input.resolved ?? true);
      break;
    case "approve":
      approveFsd(need(id), input.fsdVersionId ?? 0);
      break;
    case "generateCode":
      await generateCodeStep(need(id));
      break;
    case "review":
      await reviewStep(need(id));
      break;
    case "export":
      await exportStep(need(id), !!input.force);
      break;
    default:
      throw new StepError(`Unknown action ${action}`);
  }
  return id;
}

function need(id: number | null): number {
  if (!id) throw new StepError("No requirement selected.");
  return id;
}
