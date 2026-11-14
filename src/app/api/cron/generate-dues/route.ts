import { cronAuthorized } from "@/lib/cron";
import { generateDues } from "@/lib/plans-server";
import { sendDueReminders } from "@/lib/reminders";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const respond = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Vercel Cron (ver vercel.json). Genera los adeudos vencidos de todos los comercios y manda recordatorios. */
export async function GET(request: Request) {
  if (!cronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return respond(401, { error: "No autorizado." });
  }
  let result;
  try {
    result = await generateDues(createAdminClient(), null, null);
    console.info("cron_generate_dues", { today: result.today, created: result.created.length, skipped: result.skipped });
  } catch {
    console.error("cron_generate_dues_failed");
    return respond(503, { error: "No se pudieron generar los cobros." });
  }
  // Un fallo en recordatorios no invalida los adeudos ya generados.
  const reminders = await sendDueReminders({ today: result.today })
    .catch(() => { console.error("cron_reminders_failed"); return null; });
  return respond(200, { today: result.today, created: result.created.length, skipped: result.skipped, reminders });
}
