import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { onDuesGenerated, type GeneratedDue } from "@/lib/reminders";

export type GenerationResult = { today: string; created: GeneratedDue[]; skipped: number };

/** Genera los adeudos vencidos y avisa al gancho de recordatorios. merchantId/actor null = cron. */
export async function generateDues(admin: SupabaseClient, merchantId: string | null, actorUserId: string | null) {
  const { data, error } = await admin.rpc("generate_due_dues", {
    p_today: null, p_merchant_id: merchantId, p_actor_user_id: actorUserId,
  });
  if (error || !data) throw new Error("generate_due_dues_failed");
  const result = data as GenerationResult;
  try { await onDuesGenerated(result.created); }
  catch { console.error("plans_reminder_hook_failed", { count: result.created.length }); }
  return result;
}
