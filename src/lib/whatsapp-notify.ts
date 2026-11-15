import "server-only";
import QRCode from "qrcode";
import {
  laterReply, loadDue, payNowReply, qrReply, type Admin, type ChatReply, type DueContext,
} from "@/lib/chat-flow";
import { formatCents } from "@/lib/phone";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  dueTemplatePayload, paymentReceivedTemplatePayload, sendButtons, sendImage, sendTemplate, sendText,
  whatsappConfig, WhatsAppError, type ButtonAction, type WhatsAppConfig,
} from "@/lib/whatsapp";
import { buttonActionFromText, parseButtonPayload, type WhatsAppEvent } from "@/lib/whatsapp-webhook";

type Purpose = "due_created" | "reminder" | "qr" | "later_ack" | "payment_received" | "reply"
  | "button_pay_now" | "button_pay_qr" | "button_later" | "inbound";
type MessageRow = {
  merchant_id: string; due_id: string | null; customer_id: string | null; phone: string;
  purpose: Purpose; kind: "template" | "text" | "image" | "button" | "interactive" | "unsupported"; body: string | null;
};
const LATER_DELAY_MS = 24 * 60 * 60 * 1000;

function configOrSkip(reason: string): WhatsAppConfig | null {
  const config = whatsappConfig();
  if (!config) console.info("whatsapp_skipped", { reason: "not_configured", action: reason });
  return config;
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

/** Plantilla con "Pagar ahora" y "Más tarde". Nunca lanza: el cobro ya existe. */
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

/** Manda por WhatsApp la respuesta que calcula chat-flow: QR como imagen, botones como mensaje
 * interactivo (el cliente sigue en el chat, sin links) o texto simple. */
async function sendReply(admin: Admin, config: WhatsAppConfig, due: DueContext, phone: string, purpose: Purpose, r: ChatReply) {
  if (r.qrString) {
    const png = await QRCode.toBuffer(r.qrString, { type: "png", width: 600, margin: 2 });
    return deliver(admin, {
      merchant_id: due.merchant_id, due_id: due.id, customer_id: due.customer_id, phone, purpose: "qr", kind: "image", body: r.text,
    }, () => sendImage(config, phone, png, r.text));
  }
  if (r.buttons.length === 0) return reply(admin, config, due, phone, purpose, r.text);
  return deliver(admin, {
    merchant_id: due.merchant_id, due_id: due.id, customer_id: due.customer_id, phone, purpose, kind: "interactive", body: r.text,
  }, () => sendButtons(config, phone, r.text, due.id, r.buttons));
}

async function respond(dueId: string, phone: string, action: ButtonAction) {
  const config = configOrSkip(action);
  const admin = createAdminClient();
  const due = await loadDue(admin, dueId);
  if (!due) return;
  // "Más tarde" se registra aunque WhatsApp no esté configurado: el cron lo usa.
  const r = action === "pay_now" ? (config ? await payNowReply(due) : null)
    : action === "pay_qr" ? (config ? await qrReply(due) : null)
    : await laterReply(admin, due);
  if (!config || !r) return;
  await sendReply(admin, config, due, phone, action === "pay_later" ? "later_ack" : "reply", r);
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
        await respond(dueId, phone, action);
      }
      catch { console.error("whatsapp_followup_failed", { action, dueId }); }
    });
  }
  return followUps;
}
