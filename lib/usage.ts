// Token usage of every LLM request, as the provider reported it. Nothing is estimated here except the
// cost: token counts come only from the response's usage block, and a response without one is stored
// as "usage unavailable" with no counts.
//
// Pipeline steps open a scope saying which requirement, process and document a call belongs to;
// lib/llm.ts reports each answered request into the current scope. Rows are only ever inserted, and
// later only gain links (the version or code they produced), so history survives every new version.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { all, db, insert, now, CONSULTANT } from "./db";

export type UsageProcess =
  | "classification" // the AI's suggested WRICEF type for a new requirement
  | "rg_analysis" // Interfaces, Conversions, Forms and Enhancements: the RG Analyst reads the uploaded RG
  | "requirement_analysis" // first interview turn, from the requirement text
  | "clarification_questions" // later interview turns
  | "requirement_summary" // "Enough, write the FS": the interviewer writes the summary
  | "answer_revision"
  | "reclassification" // the interview after a change of solution type
  | "fs_generation"
  | "fs_regeneration"
  | "ts_generation"
  | "ts_regeneration"
  | "change_analysis" // Modify: which sections a change touches
  | "version_update" // Modify confirmed: the AI writes the new version
  | "code_generation"
  | "code_repair"
  | "code_review"
  | "unattributed";

export const PROCESS_LABELS: Record<UsageProcess, string> = {
  classification: "WRICEF classification",
  rg_analysis: "RG analysis",
  requirement_analysis: "Requirement analysis",
  clarification_questions: "Clarification questions",
  requirement_summary: "Requirement summary",
  answer_revision: "Answer revision",
  reclassification: "Type change interview",
  fs_generation: "FS generation",
  fs_regeneration: "FS regeneration",
  ts_generation: "TS generation",
  ts_regeneration: "TS regeneration",
  change_analysis: "Change analysis",
  version_update: "AI version update",
  code_generation: "Code generation",
  code_repair: "Code repair",
  code_review: "Code review",
  unattributed: "Other",
};

/** What one answered request reported. Counts are null when the response carried no usage block. */
export type ProviderUsage = {
  provider: string;
  requestedModel: string;
  model: string | null;
  requestId: string | null;
  responseId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  agent?: string;
  attempt: number;
  requestedAt: string;
  durationMs: number;
};

type Links = { fsdVersionId?: number | null; codeVersionId?: number | null; changeId?: number | null };
type Scope = {
  requirementId: number | null;
  process: UsageProcess;
  actor: string;
  docType: "FS" | "TS" | null;
  links: Links;
  pending: number[];
};

const store = new AsyncLocalStorage<Scope>();

export type UsageScope = {
  /** Links the requests recorded since the last link to what they produced. */
  link: (links: Links) => void;
  /** Requests after this belong to another process of the same step (code generation, then repair). */
  setProcess: (process: UsageProcess) => void;
};

export function withUsage<T>(
  context: { requirementId: number | null; process: UsageProcess; actor?: string; docType?: "FS" | "TS" | null } & Links,
  fn: (scope: UsageScope) => Promise<T>,
): Promise<T> {
  const { requirementId, process, actor = CONSULTANT, docType = null, ...links } = context;
  const scope: Scope = { requirementId, process, actor, docType, links, pending: [] };
  const handle: UsageScope = {
    link: (more) => {
      Object.assign(scope.links, more);
      if (!scope.pending.length) return;
      const ids = scope.pending.splice(0);
      const marks = ids.map(() => "?").join(",");
      db()
        .prepare(`UPDATE llm_usage SET fsd_version_id = ?, code_version_id = ?, change_id = ? WHERE id IN (${marks})`)
        .run(scope.links.fsdVersionId ?? null, scope.links.codeVersionId ?? null, scope.links.changeId ?? null, ...ids);
    },
    setProcess: (p) => {
      scope.pending.length = 0; // rows so far keep the links they were saved with
      scope.process = p;
    },
  };
  return store.run(scope, () => fn(handle));
}

/** Called by lib/llm.ts for every request the provider answered. Never throws: tracking must not break a step. */
export function recordUsage(u: ProviderUsage) {
  const scope = store.getStore();
  try {
    const id = insert(
      `INSERT INTO llm_usage (requirement_id, fsd_version_id, code_version_id, change_id, process, doc_type, agent, actor, provider,
         requested_model, model, request_id, response_id, input_tokens, output_tokens, total_tokens, cached_input_tokens,
         usage_available, attempt, duration_ms, requested_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      scope?.requirementId ?? null, scope?.links.fsdVersionId ?? null, scope?.links.codeVersionId ?? null, scope?.links.changeId ?? null,
      scope?.process ?? "unattributed", scope?.docType ?? null, u.agent ?? null, scope?.actor ?? CONSULTANT, u.provider,
      u.requestedModel, u.model, u.requestId, u.responseId, u.inputTokens, u.outputTokens, u.totalTokens, u.cachedInputTokens,
      u.inputTokens !== null || u.outputTokens !== null ? 1 : 0, u.attempt, u.durationMs, u.requestedAt, now(),
    );
    scope?.pending.push(id);
  } catch (e) {
    console.error("Token usage could not be recorded:", e);
  }
}

/** Reads the usage block of an OpenAI response: chat completions (prompt/completion) or the Responses API (input/output). */
export function openAiUsage(usage: unknown) {
  const u = (usage && typeof usage === "object" ? usage : {}) as Record<string, any>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const input = num(u.prompt_tokens) ?? num(u.input_tokens);
  const output = num(u.completion_tokens) ?? num(u.output_tokens);
  const total = num(u.total_tokens) ?? (input !== null && output !== null ? input + output : null);
  const cached = num(u.prompt_tokens_details?.cached_tokens) ?? num(u.input_tokens_details?.cached_tokens);
  return { inputTokens: input, outputTokens: output, totalTokens: total, cachedInputTokens: cached };
}

// ----------------------------------------------------------------- Pricing
type Price = { input: number; output: number; cached_input?: number };
type Pricing = { currency: string; per_tokens: number; note?: string; models: Record<string, Price> };

const PRICING_FILE = path.join(process.cwd(), "config", "openai-pricing.json");

/** Read on every call, like the prompts, so a price change needs no restart. */
export function pricing(): Pricing {
  try {
    return JSON.parse(fs.readFileSync(PRICING_FILE, "utf8")) as Pricing;
  } catch {
    return { currency: "USD", per_tokens: 1_000_000, models: {} };
  }
}

/** The longest configured name the model starts with: "gpt-4.1-mini-2025-04-14" uses "gpt-4.1-mini", not "gpt-4.1". */
export function priceFor(model: string | null, p = pricing()): (Price & { key: string }) | null {
  if (!model) return null;
  const key = Object.keys(p.models)
    .filter((k) => model === k || model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? { ...p.models[key], key } : null;
}

type UsageRow = {
  id: number; requirement_id: number | null; fsd_version_id: number | null; code_version_id: number | null; change_id: number | null;
  process: UsageProcess; doc_type: string | null; agent: string | null; actor: string; provider: string; requested_model: string;
  model: string | null; request_id: string | null; response_id: string | null; input_tokens: number | null; output_tokens: number | null;
  total_tokens: number | null; cached_input_tokens: number | null; usage_available: number; attempt: number; duration_ms: number | null;
  requested_at: string;
};

/** Estimated cost of one request, or null when its usage is unavailable or its model has no configured price. */
export function costOf(row: Pick<UsageRow, "model" | "requested_model" | "input_tokens" | "output_tokens" | "cached_input_tokens" | "usage_available">, p = pricing()) {
  if (!row.usage_available) return null;
  const price = priceFor(row.model ?? row.requested_model, p);
  if (!price) return null;
  const cached = row.cached_input_tokens ?? 0;
  const fresh = (row.input_tokens ?? 0) - cached;
  return (fresh * price.input + cached * (price.cached_input ?? price.input) + (row.output_tokens ?? 0) * price.output) / p.per_tokens;
}

export type UsageTotals = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cost: number;
  /** Requests whose response carried no usage block: counted, never guessed. */
  unavailable: number;
  /** Requests with usage but no configured price for their model: tokens counted, cost left out. */
  unpriced: number;
};

function totals(rows: UsageRow[], p: Pricing): UsageTotals {
  const t: UsageTotals = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cost: 0, unavailable: 0, unpriced: 0 };
  for (const r of rows) {
    t.requests++;
    if (!r.usage_available) {
      t.unavailable++;
      continue;
    }
    t.inputTokens += r.input_tokens ?? 0;
    t.outputTokens += r.output_tokens ?? 0;
    t.totalTokens += r.total_tokens ?? 0;
    t.cachedInputTokens += r.cached_input_tokens ?? 0;
    const c = costOf(r, p);
    if (c === null) t.unpriced++;
    else t.cost += c;
  }
  return t;
}

function groupBy(rows: UsageRow[], key: (r: UsageRow) => string, p: Pricing) {
  const groups = new Map<string, UsageRow[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  return [...groups].map(([k, g]) => ({ key: k, ...totals(g, p) })).sort((a, b) => b.totalTokens - a.totalTokens);
}

const info = (p: Pricing) => ({ currency: p.currency, note: p.note ?? null, pricedModels: Object.keys(p.models) });

/** For the dashboard: everything recorded, across all requirements. */
export function usageOverview() {
  const p = pricing();
  const rows = all<UsageRow>("SELECT * FROM llm_usage ORDER BY id");
  const titles = new Map(all<{ id: number; title: string }>("SELECT id, title FROM requirements").map((r) => [r.id, r.title]));
  return {
    pricing: info(p),
    totals: totals(rows, p),
    byProcess: groupBy(rows, (r) => r.process, p).map((g) => ({ ...g, label: PROCESS_LABELS[g.key as UsageProcess] ?? g.key })),
    byModel: groupBy(rows, (r) => r.model ?? r.requested_model, p),
    byRequirement: groupBy(rows.filter((r) => r.requirement_id !== null), (r) => String(r.requirement_id), p)
      .map((g) => ({ ...g, id: Number(g.key), title: titles.get(Number(g.key)) ?? `REQ-${g.key}` })),
  };
}

/** For one requirement: totals, per FS/TS version, and every request. */
export function requirementUsage(requirementId: number) {
  const p = pricing();
  const rows = all<UsageRow>("SELECT * FROM llm_usage WHERE requirement_id = ? ORDER BY id", requirementId);
  const versions = all<{ id: number; doc_type: string; label: string; status: string }>(
    "SELECT id, doc_type, label, status FROM fsd_versions WHERE requirement_id = ? ORDER BY doc_type, version", requirementId,
  );
  const byVersion = versions.map((v) => ({ ...v, ...totals(rows.filter((r) => r.fsd_version_id === v.id && r.code_version_id === null), p) }));
  return {
    pricing: info(p),
    totals: totals(rows, p),
    byProcess: groupBy(rows, (r) => r.process, p).map((g) => ({ ...g, label: PROCESS_LABELS[g.key as UsageProcess] ?? g.key })),
    byVersion,
    beforeFs: totals(rows.filter((r) => r.fsd_version_id === null && r.code_version_id === null), p),
    code: totals(rows.filter((r) => r.code_version_id !== null || r.process.startsWith("code_")), p),
    requests: rows.reverse().map((r) => ({
      ...r,
      processLabel: PROCESS_LABELS[r.process] ?? r.process,
      version: versions.find((v) => v.id === r.fsd_version_id) ?? null,
      cost: costOf(r, p),
    })),
  };
}

/** The requirement the current AI request belongs to, if a pipeline step opened a usage scope. */
export function currentRequirementId(): number | null {
  return store.getStore()?.requirementId ?? null;
}
