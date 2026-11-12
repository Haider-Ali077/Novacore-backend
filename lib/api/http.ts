// HTTP plumbing for the external API (/api/v1): API key, CORS and one error format. The SuperNova page
// does not go through this; it keeps using /api/pipeline and /api/state.
import { timingSafeEqual } from "node:crypto";
import { LlmError } from "../llm";
import { StepError } from "../pipeline";
import { RgError } from "../rg";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** Origins allowed to call the API from a browser (the office application), from SUPERNOVA_API_ORIGINS. */
function allowedOrigin(req: Request): string | null {
  const origin = req.headers.get("origin");
  if (!origin) return null;
  const allowed = (process.env.SUPERNOVA_API_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  return allowed.includes("*") || allowed.includes(origin) ? origin : null;
}

export function withCors(req: Request, res: Response): Response {
  const origin = allowedOrigin(req);
  if (!origin) return res;
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Key");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  headers.set("Access-Control-Expose-Headers", "Content-Disposition");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Every API call carries the key from SUPERNOVA_API_KEY, as "Authorization: Bearer <key>" or "X-API-Key".
 * Without a configured key the API is switched off, so it is never open by accident.
 */
export function authorize(req: Request) {
  const expected = process.env.SUPERNOVA_API_KEY?.trim();
  if (!expected) throw new ApiError(503, "api_disabled", "The API is not enabled: set SUPERNOVA_API_KEY on the server.");
  const given = (req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? req.headers.get("x-api-key") ?? "").trim();
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError(401, "unauthorized", "Missing or wrong API key.");
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/** One error shape for every endpoint: { error: { code, message } }. Engine errors keep their messages. */
export function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) return json({ error: { code: e.code, message: e.message } }, e.status);
  if (e instanceof StepError || e instanceof RgError) return json({ error: { code: "invalid_request", message: e.message } }, 400);
  if (e instanceof LlmError) return json({ error: { code: "ai_error", message: e.message } }, 502);
  if (e instanceof SyntaxError) return json({ error: { code: "invalid_json", message: "The request body is not valid JSON." } }, 400);
  console.error(e);
  return json({ error: { code: "internal_error", message: "Internal error." } }, 500);
}

export async function readBody<T>(req: Request): Promise<T> {
  const text = await req.text();
  return (text.trim() ? JSON.parse(text) : {}) as T;
}
