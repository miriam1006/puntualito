import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/** Adeudo recién generado por un plan (forma que devuelve public.generate_due_dues). */
export type GeneratedDue = {
  due_id: string; plan_id: string; merchant_id: string; customer_id: string;
  concept: string; amount_cents: number; due_date: string; public_token: string;
};

/** Adeudo abierto y vencido de un cliente con WhatsApp (public.due_reminder_candidates). */
export type ReminderCandidate = {
  due_id: string; merchant_id: string; merchant_name: string; customer_id: string; customer_name: string;
  phone: string; concept: string; amount_cents: number; due_date: string; days_overdue: number;
  public_token: string; plan_id: string | null;
};

/**
 * Gancho para la rama de WhatsApp: se llama después de cada generación de cobros programados
 * (cron diario y botón "Generar cobros ahora"). Hoy no envía nada. Debe tolerar llamadas repetidas
 * y no lanzar: un fallo aquí no puede deshacer los adeudos ya creados.
 */
export async function onDuesGenerated(dues: GeneratedDue[]): Promise<void> {
  if (dues.length === 0) return;
  console.info("plans_dues_generated", { count: dues.length });
}

/** Para la rama de WhatsApp: a quién recordarle hoy. Sin estado; quien envía decide la frecuencia. */
export async function listReminderCandidates(options: { today?: string; merchantId?: string } = {}): Promise<ReminderCandidate[]> {
  const { data, error } = await createAdminClient().rpc("due_reminder_candidates", {
    p_today: options.today ?? null, p_merchant_id: options.merchantId ?? null,
  });
  if (error) throw new Error("reminder_candidates_failed");
  return (data ?? []) as ReminderCandidate[];
}
