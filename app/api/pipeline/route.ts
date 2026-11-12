// The SuperNova page's endpoint: one action per request, answered with the fresh page state.
// The actions themselves are the shared backend engine (lib/service.ts), also used by the /api/v1 API.
import { StepError } from "@/lib/pipeline";
import { LlmError } from "@/lib/llm";
import { previewRgs, RgError } from "@/lib/rg";
import { performAction, type ActionInput } from "@/lib/service";
import { pageState } from "@/lib/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = ActionInput & { action: string; id?: number };

export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  // Extraction status per attachment, before anything is created; it changes no data.
  if (body.action === "previewRg") return Response.json({ ok: true, results: await previewRgs(body.rgs) });
  const ctx = { id: body.id ?? null };
  try {
    await performAction(body.action, ctx, body);
    return Response.json({ ok: true, state: pageState(ctx.id) });
  } catch (e) {
    const known = e instanceof StepError || e instanceof LlmError || e instanceof RgError;
    if (!known) console.error(e);
    return Response.json({ ok: false, error: (e as Error).message, state: pageState(ctx.id) }, { status: known ? 400 : 500 });
  }
}
