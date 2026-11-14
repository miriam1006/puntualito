import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { whatsappConfig } from "@/lib/whatsapp";
import { notifyDueCreated, notifyDueReminder } from "@/lib/whatsapp-notify";

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

/** Días de atraso en los que el cron manda recordatorio de un adeudo vencido (el cron corre una vez al día). */
export const OVERDUE_REMINDER_DAYS = [1, 3, 7];
/** Evita un segundo recordatorio si el cron se corre dos veces el mismo día. */
const REMINDER_COOLDOWN_MS = 20 * 60 * 60 * 1000;

export type ReminderDeps = {
  whatsappEnabled: () => boolean;
  notifyDueCreated: (dueId: string) => Promise<void>;
  notifyDueReminder: (dueId: string) => Promise<void>;
  /** Marca como enviadas (sent_at) las solicitudes "Más tarde" vencidas y devuelve sus adeudos. */
  claimDueReminderRequests: (now: Date) => Promise<string[]>;
  listReminderCandidates: (options: { today?: string; merchantId?: string }) => Promise<ReminderCandidate[]>;
  /** Adeudos que ya tienen recordatorio reciente o un "Más tarde" pendiente: no se les escribe. */
  dueIdsToSkip: (dueIds: string[], since: Date) => Promise<Set<string>>;
};

export type ReminderRunResult = { requests: number; overdue: number; skipped: boolean };

const defaultDeps: ReminderDeps = {
  whatsappEnabled: () => whatsappConfig() !== null,
  notifyDueCreated,
  notifyDueReminder,
  claimDueReminderRequests: async now => {
    const { data, error } = await createAdminClient().from("reminder_requests")
      .update({ sent_at: now.toISOString() })
      .is("sent_at", null).lte("remind_at", now.toISOString())
      .select("due_id");
    if (error) throw new Error("reminder_requests_claim_failed");
    return (data ?? []).map(row => row.due_id as string);
  },
  listReminderCandidates: options => listReminderCandidates(options),
  dueIdsToSkip: async (dueIds, since) => {
    if (dueIds.length === 0) return new Set();
    const admin = createAdminClient();
    const [recent, pending] = await Promise.all([
      admin.from("whatsapp_messages").select("due_id").in("due_id", dueIds)
        .eq("direction", "out").eq("purpose", "reminder").gte("created_at", since.toISOString()),
      admin.from("reminder_requests").select("due_id").in("due_id", dueIds).is("sent_at", null),
    ]);
    if (recent.error || pending.error) throw new Error("reminder_skip_lookup_failed");
    return new Set([...(recent.data ?? []), ...(pending.data ?? [])].map(row => row.due_id as string));
  },
};

/**
 * Se llama después de cada generación de cobros programados (cron diario y botón "Generar cobros ahora").
 * Manda la plantilla de cobro nuevo por WhatsApp; el índice único de whatsapp_messages garantiza un solo
 * envío por adeudo aunque se repita. Nunca lanza: un fallo aquí no puede deshacer los adeudos ya creados.
 */
export async function onDuesGenerated(dues: GeneratedDue[], deps: ReminderDeps = defaultDeps): Promise<void> {
  if (dues.length === 0) return;
  console.info("plans_dues_generated", { count: dues.length });
  if (!deps.whatsappEnabled()) {
    console.info("whatsapp_skipped", { reason: "not_configured", action: "plans_due_created", count: dues.length });
    return;
  }
  for (const due of dues) {
    try { await deps.notifyDueCreated(due.due_id); }
    catch { console.error("whatsapp_notify_failed", { action: "plans_due_created", dueId: due.due_id }); }
  }
}

/** Adeudos abiertos y vencidos a quienes se les puede escribir hoy. Sin estado. */
export async function listReminderCandidates(options: { today?: string; merchantId?: string } = {}): Promise<ReminderCandidate[]> {
  const { data, error } = await createAdminClient().rpc("due_reminder_candidates", {
    p_today: options.today ?? null, p_merchant_id: options.merchantId ?? null,
  });
  if (error) throw new Error("reminder_candidates_failed");
  return (data ?? []) as ReminderCandidate[];
}

/**
 * Parte del cron diario: atiende los "Más tarde" vencidos (reminder_requests) y recuerda los adeudos
 * vencidos en OVERDUE_REMINDER_DAYS. Sin WhatsApp configurado solo registra en logs y no toca la base.
 */
export async function sendDueReminders(
  options: { now?: Date; today?: string } = {}, deps: ReminderDeps = defaultDeps,
): Promise<ReminderRunResult> {
  if (!deps.whatsappEnabled()) {
    console.info("whatsapp_skipped", { reason: "not_configured", action: "cron_reminders" });
    return { requests: 0, overdue: 0, skipped: true };
  }
  const now = options.now ?? new Date();

  const requested = [...new Set(await deps.claimDueReminderRequests(now))];
  for (const dueId of requested) await deps.notifyDueReminder(dueId);

  const candidates = (await deps.listReminderCandidates({ today: options.today }))
    .filter(c => OVERDUE_REMINDER_DAYS.includes(c.days_overdue) && !requested.includes(c.due_id));
  const skip = await deps.dueIdsToSkip(candidates.map(c => c.due_id), new Date(now.getTime() - REMINDER_COOLDOWN_MS));
  const overdue = candidates.filter(c => !skip.has(c.due_id));
  for (const c of overdue) await deps.notifyDueReminder(c.due_id);

  console.info("cron_reminders", { requests: requested.length, overdue: overdue.length });
  return { requests: requested.length, overdue: overdue.length, skipped: false };
}
