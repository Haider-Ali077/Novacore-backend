// The external SuperNova API (v1), for the office application and other clients. It runs on the same
// backend engine as the SuperNova page: every action goes through performAction (lib/service.ts), every
// read through the page state (lib/api/views.ts). Documentation: docs/API.md.
import fs from "node:fs";
import path from "node:path";
import { get, type FsdVersion } from "@/lib/db";
import { diffFsd } from "@/lib/fsd";
import { fsdDownload } from "@/lib/fsd-download";
import { previewRgs, type RgUpload } from "@/lib/rg";
import { performAction, type ActionInput } from "@/lib/service";
import { requirementUsage, usageOverview } from "@/lib/usage";
import { CHOICES } from "@/lib/wricef";
import { ApiError, authorize, errorResponse, json, readBody, withCors } from "@/lib/api/http";
import { documentMeta, requirementList, requirementResource } from "@/lib/api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Ctx = { req: Request; url: URL; params: Record<string, string> };
type Handler = (c: Ctx) => Promise<Response> | Response;

// ------------------------------------------------------------------ helpers
const idParam = (c: Ctx, name: string) => {
  const n = Number(c.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, "invalid_request", `${name} must be a positive number.`);
  return n;
};

function requirementId(c: Ctx) {
  const id = idParam(c, "id");
  if (!get("SELECT id FROM requirements WHERE id = ?", id)) throw new ApiError(404, "not_found", `Requirement ${id} not found.`);
  return id;
}

function documentRow(c: Ctx, name = "docId") {
  const id = idParam(c, name);
  const row = get<FsdVersion>("SELECT * FROM fsd_versions WHERE id = ?", id);
  if (!row) throw new ApiError(404, "not_found", `Document version ${id} not found.`);
  return row;
}

/** Runs one engine action on a requirement and answers with the requirement as it is afterwards. */
async function act(action: string, id: number, input: ActionInput, status = 200) {
  const ctx = { id: id as number | null };
  await performAction(action, ctx, input);
  return json(requirementResource(ctx.id!), status);
}

/** WRICEF letter or choice id to the choice id the engine takes. */
const CHOICE_OF_CATEGORY: Record<string, string> = { R: "report", W: "workflow", I: "interface", C: "conversion", E: "enhancement", F: "form" };
function choiceOf(value: unknown) {
  const v = String(value ?? "").trim();
  const choice = CHOICE_OF_CATEGORY[v.toUpperCase()] ?? v.toLowerCase();
  if (!CHOICES.some((c) => c.id === choice)) throw new ApiError(400, "invalid_request", "category must be one of R, W, I, C, E, F.");
  return choice;
}

// ------------------------------------------------------------------ endpoints
const routes: [string, string, Handler][] = [
  ["GET", "", () =>
    json({
      name: "SuperNova API",
      version: "v1",
      documentation: "docs/API.md",
      endpoints: routes.map(([m, p]) => `${m} /api/v1/${p}`.replace(/\/$/, "")),
    })],

  ["GET", "categories", () =>
    json(CHOICES.filter((c) => c.supported && !c.hidden).map((c) => ({ code: c.wricef, id: c.id, label: c.label, description: c.hint, startsFromRg: !!c.fromRg })))],

  ["POST", "attachments/preview", async (c) => {
    const body = await readBody<{ attachments?: RgUpload[] }>(c.req);
    return json({ results: await previewRgs(body.attachments ?? []) });
  }],

  ["GET", "requirements", () => json(requirementList())],

  ["POST", "requirements", async (c) => {
    const body = await readBody<any>(c.req);
    const ctx = { id: null as number | null };
    try {
      await performAction("start", ctx, {
        choice: choiceOf(body.category ?? body.choice),
        text: body.text,
        client: body.client,
        project: body.project,
        rgs: body.attachments,
        rgText: body.rgText,
      });
      return json(requirementResource(ctx.id!), 201);
    } catch (e) {
      // Created, but a later part (classification, first question) failed: say which requirement it is.
      if (!ctx.id) throw e;
      const res = errorResponse(e);
      const payload = await res.json();
      return json({ ...payload, requirement: requirementResource(ctx.id) }, res.status);
    }
  }],

  ["GET", "requirements/:id", (c) => json(requirementResource(requirementId(c)))],

  ["POST", "requirements/:id/answers", async (c) => {
    const body = await readBody<{ text?: string; finish?: boolean }>(c.req);
    return act(body.finish ? "finishInterview" : "answer", requirementId(c), { text: body.text });
  }],
  ["POST", "requirements/:id/revisions", async (c) => act("reviseAnswer", requirementId(c), { text: (await readBody<{ text?: string }>(c.req)).text })],
  ["POST", "requirements/:id/classification", (c) => act("classify", requirementId(c), {})],
  ["POST", "requirements/:id/recategorize", async (c) => {
    const body = await readBody<{ category?: string }>(c.req);
    return act("startAs", requirementId(c), { wricef: String(body.category ?? "").toUpperCase() }, 201);
  }],
  ["PUT", "requirements/:id/category", async (c) => {
    const body = await readBody<{ category?: string; confirmed?: boolean }>(c.req);
    return act("changeWricef", requirementId(c), { wricef: String(body.category ?? "").toUpperCase(), confirmed: body.confirmed === true });
  }],
  ["PUT", "requirements/:id/client", async (c) => act("setClient", requirementId(c), { client: await readBody<ActionInput["client"]>(c.req) })],

  ["POST", "requirements/:id/fsd", async (c) => {
    const body = await readBody<{ confirmed?: boolean; scopeConfirmed?: boolean }>(c.req);
    return act("generateFsd", requirementId(c), { confirmed: body.confirmed === true, scopeConfirmed: body.scopeConfirmed === true });
  }],
  ["POST", "requirements/:id/ts", (c) => act("generateTs", requirementId(c), {})],

  ["POST", "requirements/:id/changes", async (c) => {
    const body = await readBody<{ text?: string; documentType?: "FS" | "TS"; baseDocumentId?: number; changeId?: number }>(c.req);
    return act("proposeChange", requirementId(c), { text: body.text, docType: body.documentType ?? "FS", fsdVersionId: body.baseDocumentId, changeId: body.changeId });
  }],
  ["POST", "requirements/:id/changes/:changeId/apply", async (c) => {
    const body = await readBody<{ changeType?: "MINOR" | "MAJOR" }>(c.req);
    return act("applyChange", requirementId(c), { changeId: idParam(c, "changeId"), changeType: body.changeType });
  }],
  ["DELETE", "requirements/:id/changes/:changeId", (c) => act("discardChange", requirementId(c), { changeId: idParam(c, "changeId") })],
  ["POST", "requirements/:id/comments", async (c) => {
    const body = await readBody<{ documentId?: number; section?: string; text?: string }>(c.req);
    return act("addComment", requirementId(c), { fsdVersionId: body.documentId, section: body.section, text: body.text });
  }],

  ["POST", "requirements/:id/code", (c) => act("generateCode", requirementId(c), {})],
  ["POST", "requirements/:id/code/review", (c) => act("review", requirementId(c), {})],
  ["POST", "requirements/:id/export", async (c) => act("export", requirementId(c), { force: (await readBody<{ force?: boolean }>(c.req)).force === true })],
  ["GET", "requirements/:id/usage", (c) => json(requirementUsage(requirementId(c)))],

  ["GET", "documents/:docId", (c) => {
    const row = documentRow(c);
    return json({ ...documentMeta(row), requirementId: row.requirement_id, sha256: row.sha256, markdown: row.markdown });
  }],
  ["PUT", "documents/:docId", async (c) => {
    const row = documentRow(c);
    const latest = get<{ id: number }>("SELECT id FROM fsd_versions WHERE requirement_id = ? AND doc_type = ? ORDER BY version DESC LIMIT 1", row.requirement_id, row.doc_type);
    if (latest?.id !== row.id) throw new ApiError(409, "not_latest", "Only the latest version can be edited; an edit creates a new version.");
    const body = await readBody<{ markdown?: string; summary?: string }>(c.req);
    return act("saveFsd", row.requirement_id, { text: body.markdown, summary: body.summary, docType: row.doc_type as "FS" | "TS" });
  }],
  ["POST", "documents/:docId/approve", (c) => {
    const row = documentRow(c);
    return act("approve", row.requirement_id, { fsdVersionId: row.id });
  }],
  ["GET", "documents/:docId/diff/:otherId", (c) => {
    const from = documentRow(c);
    const to = documentRow(c, "otherId");
    if (from.requirement_id !== to.requirement_id) throw new ApiError(400, "invalid_request", "Those versions belong to different requirements.");
    return json({ from: documentMeta(from), to: documentMeta(to), diff: diffFsd(from.markdown, to.markdown) });
  }],
  ["GET", "documents/:docId/file", async (c) => {
    const format = c.url.searchParams.get("format") === "pdf" ? "pdf" : "docx";
    const result = await fsdDownload(idParam(c, "docId"), format);
    if ("error" in result) throw new ApiError(result.status, result.status === 403 ? "not_approved" : "not_found", result.error);
    const { filename, contentType, body } = result.file;
    return new Response(body, { headers: { "Content-Type": contentType, "Content-Disposition": `attachment; filename="${filename}"` } });
  }],

  ["GET", "exports/:exportId/file", (c) => {
    const row = get<{ zip_path: string }>("SELECT zip_path FROM exports WHERE id = ?", idParam(c, "exportId"));
    if (!row || !fs.existsSync(row.zip_path)) throw new ApiError(404, "not_found", "Export not found.");
    return new Response(fs.readFileSync(row.zip_path), {
      headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${path.basename(row.zip_path)}"` },
    });
  }],

  ["GET", "usage", () => json(usageOverview())],
];

// ------------------------------------------------------------------ dispatch
function match(pattern: string, segments: string[]): Record<string, string> | null {
  const parts = pattern ? pattern.split("/") : [];
  if (parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(":")) params[parts[i].slice(1)] = decodeURIComponent(segments[i]);
    else if (parts[i] !== segments[i]) return null;
  }
  return params;
}

async function handle(req: Request, segments: string[]): Promise<Response> {
  try {
    authorize(req);
    const found = routes.map(([method, pattern, handler]) => ({ method, handler, params: match(pattern, segments) })).filter((r) => r.params);
    if (!found.length) throw new ApiError(404, "not_found", "No such endpoint. GET /api/v1 lists them.");
    const route = found.find((r) => r.method === req.method);
    if (!route) throw new ApiError(405, "method_not_allowed", `Use ${found.map((r) => r.method).join(" or ")}.`);
    return await route.handler({ req, url: new URL(req.url), params: route.params! });
  } catch (e) {
    return errorResponse(e);
  }
}

type RouteContext = { params: Promise<{ path?: string[] }> };
const entry = (method: string) => async (req: Request, { params }: RouteContext) => {
  const segments = (await params).path ?? [];
  return withCors(req, await handle(req, segments));
};

export const GET = entry("GET");
export const POST = entry("POST");
export const PUT = entry("PUT");
export const DELETE = entry("DELETE");
export async function OPTIONS(req: Request) {
  return withCors(req, new Response(null, { status: 204 }));
}
