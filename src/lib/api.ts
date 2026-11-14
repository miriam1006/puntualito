import "server-only";
import { NextResponse } from "next/server";
import { createSessionClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const NO_STORE = { "Cache-Control": "no-store" };

/** Resuelve el usuario verificado y su comercio. El navegador nunca elige el comercio. */
export async function access() {
  const client = await createSessionClient();
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) throw new ApiError(401, "Inicia sesión para continuar.");
  const admin = createAdminClient();
  const { data: merchant, error: merchantError } = await admin.from("merchants")
    .select("*").eq("owner_user_id", user.id).maybeSingle();
  if (merchantError) throw new ApiError(503, "No se pudo consultar tu negocio.");
  if (!merchant) {
    // OWNER_EMAIL solo sirve para crear el primer comercio.
    const bootstrapEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
    if (!bootstrapEmail || user.email?.toLowerCase() !== bootstrapEmail) {
      throw new ApiError(403, "Tu usuario no tiene acceso a un negocio.");
    }
  }
  return { user, admin, client, merchant: merchant as Record<string, any> | null };
}

/** Igual que access(), pero exige que el comercio ya exista. */
export async function merchantAccess() {
  const context = await access();
  if (!context.merchant) throw new ApiError(409, "Primero crea tu comercio.");
  return { ...context, merchant: context.merchant };
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = process.env.APP_URL;
  if (!expected || origin !== new URL(expected).origin) throw new ApiError(403, "Solicitud no autorizada.");
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new ApiError(415, "Se requiere JSON.");
}

export async function jsonBody(request: Request) {
  if (Number(request.headers.get("content-length")) > 4096) throw new ApiError(413, "Solicitud demasiado grande.");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "Faltan datos.");
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4096) { await reader.cancel(); throw new ApiError(413, "Solicitud demasiado grande."); }
    parts.push(value);
  }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown; }
  catch { throw new ApiError(400, "JSON inválido."); }
}

export function ok(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function fail(error: unknown) {
  if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.status, headers: NO_STORE });
  return NextResponse.json({ error: "No se pudo completar la operación. Intenta de nuevo." }, { status: 503, headers: NO_STORE });
}

/** Lo único de un intento que puede ver quien abre el link público. */
export function publicAttempt(a: Record<string, any> | null | undefined) {
  if (!a) return null;
  if (!["creating", "pending"].includes(a.status) || Date.parse(a.expires_at) <= Date.now()) return null;
  return { kind: a.kind, status: a.status, qr_string: a.kind === "qr" ? a.qr_string : null, expires_at: a.expires_at };
}
