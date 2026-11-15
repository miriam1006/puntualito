import "server-only";
import QRCode from "qrcode";
import { ApiError } from "@/lib/api";
import { openAttempt } from "@/lib/attempts";
import { formatCents } from "@/lib/phone";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  dueTemplatePayload, paymentReceivedTemplatePayload, sendButtons, sendImage, sendTemplate, sendText,
  whatsappConfig, WhatsAppError, type ButtonAction, type WhatsAppConfig,
} from "@/lib/whatsapp";
import { buttonActionFromText, parseButtonPayload, type WhatsAppEvent } from "@/lib/whatsapp-webhook";

type Admin = ReturnType<typeof createAdminClient>;
type Purpose = "due_created" | "reminder" | "qr" | "later_ack" | "payment_received" | "reply"
  | "button_pay_now" | "button_pay_qr" | "button_later" | "inbound";
type MessageRow = {
  merchant_id: string; due_id: string | null; customer_id: string | null; phone: string;
  purpose: Purpose; kind: "template" | "text" | "image" | "button" | "interactive" | "unsupported"; body: string | null;
};
type DueContext = {
  id: string; merchant_id: string; customer_id: string | null; concept: string; amount_cents: number;
  status: string; public_token: string; merchantName: string;
  customer: { id: string; name: string; phone: string | null; active: boolean; whatsapp_opt_in: boolean } | null;
};

const LATER_DELAY_MS = 24 * 60 * 60 * 1000;

function configOrSkip(reason: string): WhatsAppConfig | null {
  const config = whatsappConfig();
  if (!config) console.info("whatsapp_skipped", { reason: "not_configured", action: reason });
  return config;
}

async function loadDue(admin: Admin, dueId: string): Promise<DueContext | null> {
  const { data, error } = await admin.from("dues")
    .select("id,merchant_id,customer_id,concept,amount_cents,status,public_token,merchants(name),customers(id,name,phone,active,whatsapp_opt_in)")
    .eq("id", dueId).maybeSingle();
  if (error) throw new Error("due_lookup_failed");
  if (!data) return null;
  const merchant = (Array.isArray(data.merchants) ? data.merchants[0] : data.merchants) as { name?: string } | null;
  const customer = (Array.isArray(data.customers) ? data.customers[0] : data.customers) as DueContext["customer"];
  return { ...(data as Omit<DueContext, "merchantName" | "customer">), merchantName: merchant?.name ?? "", customer };
}

/** Inserta el mensaje antes de llamar a Meta. Para 'due_created' y 'payment_received' el índice único
 * garantiza un solo envío por adeudo aunque el webhook de Pey o la creación se repitan. */
async function reserve(admin: Admin, row: MessageRow): Promise<string | null> {
  const { data, error } = await admin.from("whatsapp_messages").insert({ ...row, direction: "out" }).select("id").single();
  if (error) {
    if (error.code === "23505") return null;
    throw new Error("whatsapp_reserve_failed");
  }
  return data.id as string;
}

async function deliver(admin: Admin, row: MessageRow, send: () => Promise<{ waMessageId: string }>) {
  const id = await reserve(admin, row);
  if (!id) return;
  try {
    const { waMessageId } = await send();
    await admin.from("whatsapp_messages").update({ wa_message_id: waMessageId }).eq("id", id);
    console.info("whatsapp_sent", { messageId: id, purpose: row.purpose });
  } catch (e) {
    const meta = e instanceof WhatsAppError ? e : null;
    await admin.from("whatsapp_messages").update({
      status: "failed", status_at: new Date().toISOString(),
      error_code: meta?.metaCode ?? meta?.code ?? "unknown", error_title: meta?.metaTitle ?? null,
    }).eq("id", id);
    console.warn("whatsapp_send_failed", { messageId: id, purpose: row.purpose, code: meta?.code, metaCode: meta?.metaCode });
  }
}

function eligiblePhone(due: DueContext): string | null {
  const c = due.customer;
  if (!c?.active || !c.phone) return null;
  // Meta exige consentimiento para mensajes que inicia el negocio.
  if (!c.whatsapp_opt_in) { console.info("whatsapp_skipped", { reason: "no_opt_in", dueId: due.id }); return null; }
  return c.phone;
}

async function sendDueTemplate(dueId: string, purpose: "due_created" | "reminder") {
  const config = configOrSkip(purpose);
  if (!config) return;
  const template = purpose === "due_created" ? config.templates.newDue : config.templates.reminder ?? config.templates.newDue;
  if (!template) { console.info("whatsapp_skipped", { reason: "template_missing", action: purpose }); return; }
  const admin = createAdminClient();
  const due = await loadDue(admin, dueId);
  if (!due || due.status !== "open") return;
  const phone = eligiblePhone(due);
  if (!phone) return;
  const amount = formatCents(due.amount_cents);
  await deliver(admin, {
    merchant_id: due.merchant_id, due_id: due.id, customer_id: due.customer_id, phone, purpose, kind: "template",
    body: `${purpose === "due_created" ? "Cobro" : "Recordatorio"}: ${due.concept} por ${amount}`,
  }, () => sendTemplate(config, dueTemplatePayload({
    to: phone, template, language: config.language, customerName: due.customer?.name ?? "",
    merchantName: due.merchantName, concept: due.concept, amount, dueId: due.id,
  })));
}

/** Plantilla con "Pagar ahora", "Más tarde" y "Prefiero QR". Nunca lanza: el cobro ya existe. */
export async function notifyDueCreated(dueId: string) {
  try { await sendDueTemplate(dueId, "due_created"); }
  catch { console.error("whatsapp_notify_failed", { action: "due_created", dueId }); }
}

/** Para el cron de recordatorios: usa WHATSAPP_TEMPLATE_REMINDER (o la de cobro nuevo). */
export async function notifyDueReminder(dueId: string) {
  try { await sendDueTemplate(dueId, "reminder"); }
  catch { console.error("whatsapp_notify_failed", { action: "reminder", dueId }); }
}

/** "Pago recibido" tras confirmar el pago en process_pey_payment. Sin plantilla solo llega
 * si el cliente escribió en las últimas 24 h (regla de Meta). */
export async function notifyPaymentReceived(dueId: string) {
  try {
    const config = configOrSkip("payment_received");
    if (!config) return;
    const admin = createAdminClient();
    const due = await loadDue(admin, dueId);
    if (!due || due.status !== "paid") return;
    const phone = eligiblePhone(due);
    if (!phone) return;
    const amount = formatCents(due.amount_cents);
    const text = `Recibimos tu pago de ${amount} por ${due.concept} a ${due.merchantName}. ¡Gracias!`;
    const template = config.templates.paymentReceived;
    await deliver(admin, {
      merchant_id: due.merchant_id, due_id: due.id, customer_id: due.customer_id, phone,
      purpose: "payment_received", kind: template ? "template" : "text", body: text,
    }, () => template
      ? sendTemplate(config, paymentReceivedTemplatePayload({
        to: phone, template, language: config.language, concept: due.concept, amount, merchantName: due.merchantName,
      }))
      : sendText(config, phone, text));
  } catch { console.error("whatsapp_notify_failed", { action: "payment_received", dueId }); }
}

async function reply(admin: Admin, config: WhatsAppConfig, due: DueContext, phone: string, purpose: Purpose, text: string) {
  await deliver(admin, {
    merchant_id: due.merchant_id, due_id: due.id, customer_id: due.customer_id, phone, purpose, kind: "text", body: text,
  }, () => sendText(config, phone, text));
}

/** Respuesta con botones: el cliente sigue en el chat en lugar de abrir un link. */
async function replyWithButtons(admin: Admin, config: WhatsAppConfig, due: DueContext, phone: string, purpose: Purpose,
  text: string, actions: ButtonAction[]) {
  await deliver(admin, {
    merchant_id: due.merchant_id, due_id: due.id, customer_id: due.customer_id, phone, purpose, kind: "interactive", body: text,
  }, () => sendButtons(config, phone, text, due.id, actions));
}

/** "Pagar ahora": manda la solicitud de CoDi a la app del banco del celular registrado, sin links. */
async function replyWithPush(dueId: string, phone: string) {
  const config = configOrSkip("pay_now");
  if (!config) return;
  const admin = createAdminClient();
  const due = await loadDue(admin, dueId);
  if (!due) return;
  if (due.status !== "open") return reply(admin, config, due, phone, "reply", CLOSED_TEXT[due.status] ?? CLOSED_TEXT.cancelled);
  const amount = formatCents(due.amount_cents);
  let attempt: Record<string, any> | null;
  try {
    attempt = (await openAttempt(due.public_token, "push")).attempt;
  } catch (e) {
    const detail = e instanceof ApiError ? e.message : "No pudimos enviar la solicitud a tu banco.";
    return replyWithButtons(admin, config, due, phone, "reply", `${detail} ${ACTIVATE_CODI}`, ["pay_now", "pay_qr"]);
  }
  if (attempt?.kind === "push") {
    const text = attempt.status === "creating"
      ? "Estamos enviando la solicitud de pago a la app de tu banco. Te llegará en un momento."
      : `Listo. Te llegó una notificación de tu banco para pagar ${amount} a ${due.merchantName} con CoDi. `
        + `Ábrela y autoriza el pago; vence ${expiresIn(attempt.expires_at)}.\n\n¿No te llegó? ${ACTIVATE_CODI}`;
    return replyWithButtons(admin, config, due, phone, "reply", text, ["pay_qr"]);
  }
  // Ya hay un QR vigente para este cobro: un solo intento vivo por adeudo.
  return replyWithButtons(admin, config, due, phone, "reply",
    `Ya te mandamos un código QR para este cobro; vence ${expiresIn(attempt?.expires_at)}. `
    + "Escanéalo desde otra pantalla o guárdalo y léelo desde la app de tu banco (CoDi).", ["pay_qr"]);
}

const ACTIVATE_CODI = "Revisa que tengas CoDi activado en la app de tu banco y vuelve a tocar «Pagar ahora». "
  + "Si no lo tienes, te mandamos un código QR.";

/** "en 4 minutos" a partir de expires_at del intento; sin fecha, "en unos minutos". */
function expiresIn(expiresAt: unknown): string {
  const ms = typeof expiresAt === "string" ? Date.parse(expiresAt) - Date.now() : NaN;
  if (!Number.isFinite(ms) || ms <= 0) return "en unos minutos";
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes === 1 ? "en 1 minuto" : `en ${minutes} minutos`;
}

const CLOSED_TEXT: Record<string, string> = {
  paid: "Este cobro ya está pagado. ¡Gracias!",
  review: "Ya recibimos un pago para este cobro. El negocio lo está revisando.",
  cancelled: "Este cobro fue cancelado por el negocio.",
};

async function replyWithQr(dueId: string, phone: string) {
  const config = configOrSkip("pay_qr");
  if (!config) return;
  const admin = createAdminClient();
  const due = await loadDue(admin, dueId);
  if (!due) return;
  if (due.status !== "open") return reply(admin, config, due, phone, "reply", CLOSED_TEXT[due.status] ?? CLOSED_TEXT.cancelled);
  let attempt: Record<string, any> | null;
  try {
    attempt = (await openAttempt(due.public_token, "qr")).attempt;
  } catch (e) {
    const detail = e instanceof ApiError ? e.message : "No pudimos generar el QR.";
    return replyWithButtons(admin, config, due, phone, "reply", `${detail} Toca de nuevo en un momento.`, ["pay_qr"]);
  }
  if (!attempt || attempt.kind !== "qr" || !attempt.qr_string) {
    // Un solo intento vivo por adeudo: mientras el push siga vigente no se puede crear el QR (evita cobrar dos veces).
    const text = attempt?.kind === "push"
      ? `La notificación que enviamos a tu banco sigue vigente; vence ${expiresIn(attempt.expires_at)}. `
        + "Si no te llegó, toca «Enviar QR» cuando venza y te lo mandamos."
      : "Estamos preparando tu QR. Toca «Enviar QR» en un momento.";
    return replyWithButtons(admin, config, due, phone, "reply", text, ["pay_qr"]);
  }
  const png = await QRCode.toBuffer(attempt.qr_string, { type: "png", width: 600, margin: 2 });
  const caption = `${due.concept} · ${formatCents(due.amount_cents)} para ${due.merchantName}. `
    + `Escanéalo desde otra pantalla o guárdalo y léelo desde la app de tu banco (CoDi). Vence ${expiresIn(attempt.expires_at)}.`;
  await deliver(admin, {
    merchant_id: due.merchant_id, due_id: due.id, customer_id: due.customer_id, phone, purpose: "qr", kind: "image", body: caption,
  }, () => sendImage(config, phone, png, caption));
}

async function recordLater(dueId: string, phone: string) {
  const admin = createAdminClient();
  const remindAt = new Date(Date.now() + LATER_DELAY_MS).toISOString();
  const { data, error } = await admin.rpc("request_due_reminder", { p_due_id: dueId, p_source: "whatsapp", p_remind_at: remindAt });
  if (error) throw new Error("reminder_request_failed");
  const config = configOrSkip("pay_later");
  if (!config) return;
  const due = await loadDue(admin, dueId);
  if (!due) return;
  const saved = Array.isArray(data) ? data[0] : data;
  if (!saved?.id) return reply(admin, config, due, phone, "later_ack", CLOSED_TEXT[due.status] ?? CLOSED_TEXT.cancelled);
  await replyWithButtons(admin, config, due, phone, "later_ack",
    "Listo, te lo recordamos mañana. Si quieres pagar antes, toca «Pagar ahora».", ["pay_now"]);
}

type Original = { merchant_id: string; due_id: string | null; customer_id: string | null; phone: string };

async function findOriginal(admin: Admin, contextId: string | null, phone: string): Promise<Original | null> {
  const query = admin.from("whatsapp_messages").select("merchant_id,due_id,customer_id,phone").eq("direction", "out");
  const { data, error } = contextId
    ? await query.eq("wa_message_id", contextId).maybeSingle()
    : await query.eq("phone", phone).gte("created_at", new Date(Date.now() - 30 * LATER_DELAY_MS).toISOString())
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error("whatsapp_lookup_failed");
  return data as Original | null;
}

/** Registra estados y mensajes entrantes (idempotente por wamid). Devuelve las respuestas a enviar,
 * que el webhook corre después de contestar 200 a Meta. Lanza ante un error de base de datos. */
export async function handleWhatsAppEvents(events: WhatsAppEvent[]): Promise<Array<() => Promise<void>>> {
  const admin = createAdminClient();
  const followUps: Array<() => Promise<void>> = [];
  for (const event of events) {
    if (event.type === "status") {
      const { error } = await admin.rpc("record_whatsapp_status", {
        p_wa_message_id: event.waMessageId, p_status: event.status, p_at: event.at.toISOString(),
        p_error_code: event.errorCode, p_error_title: event.errorTitle,
      });
      if (error) throw new Error("whatsapp_status_failed");
      continue;
    }
    const phone = event.phone;
    if (!phone) { console.info("whatsapp_inbound_ignored", { reason: "non_mx_phone" }); continue; }
    const original = await findOriginal(admin, event.contextId, phone);
    // El remitente lo autentica Meta (firma), pero debe ser el mismo celular al que escribimos.
    if (!original || original.phone !== phone) {
      console.info("whatsapp_inbound_ignored", { reason: "no_matching_conversation" });
      continue;
    }
    const parsed = parseButtonPayload(event.buttonPayload);
    let action: ButtonAction | null = parsed ? parsed.action : event.kind === "text" ? null : buttonActionFromText(event.text);
    if (parsed && parsed.dueId !== original.due_id) action = null;
    const purpose: Purpose = action === "pay_now" ? "button_pay_now" : action === "pay_qr" ? "button_pay_qr"
      : action === "pay_later" ? "button_later" : "inbound";
    const { error } = await admin.from("whatsapp_messages").insert({
      merchant_id: original.merchant_id, due_id: original.due_id, customer_id: original.customer_id, phone,
      direction: "in", purpose, kind: event.kind, body: event.text?.slice(0, 1024) ?? null,
      wa_message_id: event.waMessageId, context_wa_message_id: event.contextId,
      status: "received", status_at: event.receivedAt.toISOString(),
    });
    if (error) {
      if (error.code === "23505") continue;
      throw new Error("whatsapp_inbound_failed");
    }
    const dueId = original.due_id;
    if (!dueId || !action) continue;
    followUps.push(async () => {
      try {
        await (action === "pay_now" ? replyWithPush(dueId, phone)
          : action === "pay_qr" ? replyWithQr(dueId, phone) : recordLater(dueId, phone));
      }
      catch { console.error("whatsapp_followup_failed", { action, dueId }); }
    });
  }
  return followUps;
}
