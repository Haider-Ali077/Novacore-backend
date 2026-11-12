// The external API's resources, read from the same page state the SuperNova page uses (lib/state.ts),
// so both always show the same data. Only the shape differs: stable field names, no UI-only parts.
import { pageState } from "../state";
import { fromRgType, wricefCode, wricefLabel } from "../wricef";
import { fsTraceability, mandatoryGaps } from "../validation";

/* eslint-disable @typescript-eslint/no-explicit-any */

const category = (w: string | null | undefined) => ({ code: wricefCode(w), label: wricefLabel(w) });

/** A document version without its text (GET /documents/{id} returns the text). */
export const documentMeta = (v: any) =>
  v && {
    id: v.id,
    type: v.doc_type ?? "FS",
    version: v.label,
    status: v.status,
    approved: v.status === "APPROVED",
    changeType: v.change_type,
    changeSummary: v.change_summary,
    basedOnVersion: v.parent_label ?? null,
    fsVersion: v.fs_label ?? null,
    requirementRevision: v.requirement_revision ?? null,
    createdAt: v.created_at,
  };

export function requirementList() {
  return pageState(null).requirements.map((r: any) => ({ id: r.id, title: r.title, status: r.status, category: category(r.wricef) }));
}

export function requirementResource(id: number) {
  const s: any = pageState(id);
  const r = s.requirement;
  if (!r) return null;
  const last = s.messages[s.messages.length - 1];
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    category: category(r.wricef),
    executionMode: r.execution_mode ?? null,
    project: r.project ?? null,
    client: r.client ? { id: r.client.id, name: r.client.name, hasLogo: r.client.hasLogo } : null,
    linkedRequirementId: r.linked_requirement_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    classification: r.classification,
    categoryBlock: r.categoryBlock,
    interview: {
      questionsAsked: r.questions_asked,
      maxQuestions: fromRgType(r.wricef) ? s.rgMaxQuestions : s.maxQuestions,
      waitingForAnswer: !r.categoryBlock && r.status === "INTERVIEW" && last?.role === "assistant",
      coverage: r.interview?.coverage ?? [],
      contradictions: r.interview?.contradictions ?? [],
      tracked: r.interview?.tracked ?? [],
      mandatoryMissing: r.interview?.mandatory_missing ?? [],
      messages: s.messages.map((m: any) => ({ role: m.role, content: m.content, createdAt: m.created_at })),
    },
    summary: r.summary,
    revisions: s.revisions,
    rg: s.rg,
    attachments: s.attachments,
    fs: { current: documentMeta(s.fsd), versions: s.fsdVersions.map(documentMeta), openChange: s.fsdChange },
    ts: { current: documentMeta(s.ts), versions: s.tsVersions.map(documentMeta), openChange: s.tsChange },
    approvals: s.approvals.map((a: any) => ({ documentId: a.fsd_version_id, type: a.doc_type, version: a.label, decision: a.decision, approver: a.approver, sha256: a.sha256, decidedAt: a.decided_at })),
    code: {
      blocker: r.codeBlocker,
      versions: s.code.map((c: any) => ({
        id: c.id, version: c.version, kind: c.kind, objectType: c.object_type, name: c.program_name, title: c.title,
        source: c.abap_source, selectionTexts: c.selection_texts, manualSteps: c.manual_steps,
        checks: { errors: c.checks.errors, warnings: c.checks.warnings, issues: c.checks.issues }, review: c.review, createdAt: c.created_at,
      })),
    },
    exports: s.exports.map((e: any) => ({ id: e.id, codeVersionId: e.code_version_id, commit: e.commit_sha, createdAt: e.created_at })),
    validation: {
      mandatoryGaps: r.summary ? mandatoryGaps(r.wricef, r.summary) : r.interview?.mandatory_missing ?? [],
      traceability: s.fsd ? fsTraceability(s.fsd.markdown, r.wricef) : null,
      fsChecks: s.guard?.fsChecks ?? null,
      guardrailEvents: s.guard?.events ?? [],
    },
    usage: s.requirementUsage?.totals ?? null,
  };
}
