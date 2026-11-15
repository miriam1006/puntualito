import "server-only";
import { ApiError } from "@/lib/api";
import { openAttempt } from "@/lib/attempts";
import { formatCents } from "@/lib/phone";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ButtonAction } from "@/lib/whatsapp";

/** Respuestas del chat de cobro. Las usan el webhook de WhatsApp (que las manda por Meta) y la
 * vista previa del chat (que las muestra en pantalla): el cobro CoDi detrás es el mismo y es real. */

export type Admin = ReturnType<typeof createAdminClient>;
export type DueContext = {
  id: string; merchant_id: string; customer_id: string | null; concept: string; amount_cents: number;
  status: string; public_token: string; merchantName: string;
  customer: { id: string; name: string; phone: string | null; active: boolean; whatsapp_opt_in: boolean } | null;
};
/** qrString solo cuando la respuesta es el QR de CoDi (WhatsApp lo manda como imagen). */
export type ChatReply = { text: string; buttons: ButtonAction[]; qrString?: string };

const DUE_SELECT = "id,merchant_id,customer_id,concept,amount_cents,status,public_token,merchants(name),customers(id,name,phone,active,whatsapp_opt_in)";
const LATER_DELAY_MS = 24 * 60 * 60 * 1000;

function toContext(data: Record<string, any>): DueContext {
  const merchant = (Array.isArray(data.merchants) ? data.merchants[0] : data.merchants) as { name?: string } | null;
  const customer = (Array.isArray(data.customers) ? data.customers[0] : data.customers) as DueContext["customer"];
  return { ...(data as Omit<DueContext, "merchantName" | "customer">), merchantName: merchant?.name ?? "", customer };
}

export async function loadDue(admin: Admin, dueId: string): Promise<DueContext | null> {
  const { data, error } = await admin.from("dues").select(DUE_SELECT).eq("id", dueId).maybeSingle();
  if (error) throw new Error("due_lookup_failed");
  return data ? toContext(data) : null;
}

export async function loadDueByToken(admin: Admin, token: string): Promise<DueContext | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const { data, error } = await admin.from("dues").select(DUE_SELECT).eq("public_token", token).maybeSingle();
  if (error) throw new Error("due_lookup_failed");
  return data ? toContext(data) : null;
}

export const CLOSED_TEXT: Record<string, string> = {
  paid: "Este cobro ya está pagado. ¡Gracias!",
  review: "Ya recibimos un pago para este cobro. El negocio lo está revisando.",
  cancelled: "Este cobro fue cancelado por el negocio.",
};

const ACTIVATE_CODI = "Revisa que tengas CoDi activado en la app de tu banco y vuelve a tocar «Pagar ahora». "
  + "Si no lo tienes, te mandamos un código QR.";

/** "en 4 minutos" a partir de expires_at del intento; sin fecha, "en unos minutos". */
export function expiresIn(expiresAt: unknown, now = Date.now()): string {
  const ms = typeof expiresAt === "string" ? Date.parse(expiresAt) - now : NaN;
  if (!Number.isFinite(ms) || ms <= 0) return "en unos minutos";
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes === 1 ? "en 1 minuto" : `en ${minutes} minutos`;
}

function closed(due: DueContext): ChatReply | null {
  return due.status === "open" ? null : { text: CLOSED_TEXT[due.status] ?? CLOSED_TEXT.cancelled, buttons: [] };
}

/** Texto de la plantilla de cobro (el mismo cuerpo que se registra en Meta). */
export function dueMessageText(due: Pick<DueContext, "merchantName" | "concept" | "amount_cents">, customerName?: string) {
  const greeting = customerName?.trim() ? `Hola, ${customerName.trim()}.` : "Hola.";
  return `${greeting} Tienes un cobro de ${due.merchantName} por ${due.concept}. `
    + `El monto es ${formatCents(due.amount_cents)}. ¿Cómo quieres pagarlo?`;
}

/** "Pagar ahora": abre (o reutiliza) un intento push en Pey hacia el celular registrado. */
export async function payNowReply(due: DueContext): Promise<ChatReply> {
  const done = closed(due);
  if (done) return done;
  let attempt: Record<string, any> | null;
  try {
    attempt = (await openAttempt(due.public_token, "push")).attempt;
  } catch (e) {
    const detail = e instanceof ApiError ? e.message : "No pudimos enviar la solicitud a tu banco.";
    return { text: `${detail} ${ACTIVATE_CODI}`, buttons: ["pay_now", "pay_qr"] };
  }
  if (attempt?.kind === "push") {
    if (attempt.status === "creating") {
      return { text: "Estamos enviando la solicitud de pago a la app de tu banco. Te llegará en un momento.", buttons: ["pay_qr"] };
    }
    return {
      text: `Listo. Te llegó una notificación de tu banco para pagar ${formatCents(due.amount_cents)} a ${due.merchantName} con CoDi. `
        + `Ábrela y autoriza el pago; vence ${expiresIn(attempt.expires_at)}.\n\n¿No te llegó? ${ACTIVATE_CODI}`,
      buttons: ["pay_qr"],
    };
  }
  // Ya hay un QR vigente para este cobro: un solo intento vivo por adeudo.
  return {
    text: `Ya te mandamos un código QR para este cobro; vence ${expiresIn(attempt?.expires_at)}. `
      + "Escanéalo desde otra pantalla o guárdalo y léelo desde la app de tu banco (CoDi).",
    buttons: ["pay_qr"],
  };
}

/** "Enviar QR": respaldo cuando el push no llega. */
export async function qrReply(due: DueContext): Promise<ChatReply> {
  const done = closed(due);
  if (done) return done;
  let attempt: Record<string, any> | null;
  try {
    attempt = (await openAttempt(due.public_token, "qr")).attempt;
  } catch (e) {
    const detail = e instanceof ApiError ? e.message : "No pudimos generar el QR.";
    return { text: `${detail} Toca de nuevo en un momento.`, buttons: ["pay_qr"] };
  }
  if (!attempt || attempt.kind !== "qr" || !attempt.qr_string) {
    // Mientras el push siga vigente no se crea el QR: evita cobrar dos veces.
    const text = attempt?.kind === "push"
      ? `La notificación que enviamos a tu banco sigue vigente; vence ${expiresIn(attempt.expires_at)}. `
        + "Si no te llegó, toca «Enviar QR» cuando venza y te lo mandamos."
      : "Estamos preparando tu QR. Toca «Enviar QR» en un momento.";
    return { text, buttons: ["pay_qr"] };
  }
  return {
    text: `${due.concept} · ${formatCents(due.amount_cents)} para ${due.merchantName}. `
      + `Escanéalo desde otra pantalla o guárdalo y léelo desde la app de tu banco (CoDi). Vence ${expiresIn(attempt.expires_at)}.`,
    buttons: [],
    qrString: attempt.qr_string as string,
  };
}

/** "Más tarde": agenda el recordatorio de mañana (reminder_requests) y lo confirma. */
export async function laterReply(admin: Admin, due: DueContext): Promise<ChatReply> {
  const remindAt = new Date(Date.now() + LATER_DELAY_MS).toISOString();
  const { data, error } = await admin.rpc("request_due_reminder", { p_due_id: due.id, p_source: "whatsapp", p_remind_at: remindAt });
  if (error) throw new Error("reminder_request_failed");
  const saved = Array.isArray(data) ? data[0] : data;
  if (!saved?.id) return { text: CLOSED_TEXT[due.status] ?? CLOSED_TEXT.cancelled, buttons: [] };
  return { text: "Listo, te lo recordamos mañana. Si quieres pagar antes, toca «Pagar ahora».", buttons: ["pay_now"] };
}
