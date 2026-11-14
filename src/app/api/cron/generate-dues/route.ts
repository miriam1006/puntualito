import { cronAuthorized } from "@/lib/cron";
import { generateDues } from "@/lib/plans-server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const respond = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Vercel Cron (ver vercel.json). Genera los adeudos vencidos de todos los comercios. */
export async function GET(request: Request) {
  if (!cronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return respond(401, { error: "No autorizado." });
  }
  try {
    const result = await generateDues(createAdminClient(), null, null);
    console.info("cron_generate_dues", { today: result.today, created: result.created.length, skipped: result.skipped });
    return respond(200, { today: result.today, created: result.created.length, skipped: result.skipped });
  } catch {
    console.error("cron_generate_dues_failed");
    return respond(503, { error: "No se pudieron generar los cobros." });
  }
}
