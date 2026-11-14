import { createAdminClient } from "@/lib/supabase/admin";
import { peyPushPaymentSchema, peyQrPaymentSchema, pesosToCents, verifyPeyWebhook } from "@/lib/payment-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 128 * 1024;
const respond = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function readLimitedBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("body_too_large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(request: Request) {
  const secret = process.env.PEY_WEBHOOK_SECRET;
  const expectedApiKeyId = process.env.PEY_API_KEY_ID;
  if (!secret || !expectedApiKeyId) {
    console.error("pey_webhook_rejected", { reason: "configuration_missing", status: 503 });
    return respond(503, { error: "Webhook sin configurar." });
  }

  const id = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signature = request.headers.get("webhook-signature");
  if (!id || id.length > 256 || !timestamp || !signature) {
    console.warn("pey_webhook_rejected", { reason: "headers_missing_or_invalid", status: 401 });
    return respond(401, { error: "Firma inválida." });
  }
  let rawBody: string;
  try { rawBody = await readLimitedBody(request); }
  catch { return respond(413, { error: "Solicitud demasiado grande." }); }

  let verified: unknown;
  try {
    // La librería verifica firma y tolerancia de cinco minutos del timestamp.
    // Nunca hacer JSON.parse ni reserializar antes de verificar.
    verified = verifyPeyWebhook(rawBody, secret, {
      "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signature,
    });
  } catch {
    console.warn("pey_webhook_rejected", { webhookId: id, reason: "signature_or_timestamp_invalid", status: 401 });
    return respond(401, { error: "Firma inválida." });
  }
  if (typeof verified !== "object" || verified === null) return respond(400, { error: "Evento inválido." });

  const type = (verified as { type?: unknown }).type;
  let payment: {
    kind: "qr" | "push"; payload: Record<string, unknown>; apiKeyId: string | null | undefined;
    peyRef: string; numRef: string | null; transactionId: string; amount: number; datePaid: number;
  };
  if (type === "codi.qr.payment_received") {
    const parsed = peyQrPaymentSchema.safeParse(verified);
    if (!parsed.success) return invalidContract(id, parsed.error.issues.map(issue => issue.path.join(".")));
    const p = parsed.data;
    payment = { kind: "qr", payload: p, apiKeyId: p.apiKeyId, peyRef: p.codiQrId, numRef: p.numRef,
      transactionId: p.transactionId, amount: p.amount, datePaid: p.datePaid };
  } else if (type === "codi.pn.payment_received") {
    const parsed = peyPushPaymentSchema.safeParse(verified);
    if (!parsed.success) return invalidContract(id, parsed.error.issues.map(issue => issue.path.join(".")));
    const p = parsed.data;
    // En push, la referencia guardada al crear el cobro es el transactionId.
    payment = { kind: "push", payload: p, apiKeyId: p.apiKeyId, peyRef: p.transactionId, numRef: p.numRef ?? null,
      transactionId: p.transactionId, amount: p.amount, datePaid: p.datePaid };
  } else {
    // Otros eventos firmados (por ejemplo bank.account.updated) no cambian cobros.
    console.info("pey_webhook_ignored", { webhookId: id, reason: "unsupported_event_type" });
    return respond(200, { received: true, ignored: true });
  }

  if (payment.apiKeyId && payment.apiKeyId !== expectedApiKeyId) {
    console.warn("pey_webhook_rejected", { webhookId: id, reason: "api_key_id_mismatch", status: 401 });
    return respond(401, { error: "Cuenta no autorizada." });
  }

  try {
    const { data, error } = await createAdminClient().rpc("process_pey_payment", {
      p_webhook_id: id,
      p_payload: payment.payload,
      p_pey_api_key_id: expectedApiKeyId,
      p_kind: payment.kind,
      p_pey_ref: payment.peyRef,
      p_num_ref: payment.numRef,
      p_transaction_id: payment.transactionId,
      p_amount_cents: pesosToCents(payment.amount),
      p_paid_at: new Date(payment.datePaid * 1000).toISOString(),
    });
    if (error || !data || data.retry) {
      // Un fallo de base de datos o un cobro sin identificar nunca se confirma como procesado:
      // Pey reintentará la entrega. Sin payload crudo en los logs.
      console.error("pey_webhook_processing_pending", { webhookId: id, code: error?.code, outcome: data?.outcome });
      return respond(503, { error: "Pago pendiente de procesamiento." });
    }
    console.info("pey_webhook_processed", { webhookId: id, outcome: data.outcome });
    return respond(200, { received: true });
  } catch {
    console.error("pey_webhook_processing_failed", { webhookId: id });
    return respond(503, { error: "No se pudo procesar el pago." });
  }
}

function invalidContract(webhookId: string, fields: string[]) {
  console.warn("pey_webhook_rejected", { webhookId, reason: "payment_contract_invalid", fields: fields.slice(0, 12), status: 400 });
  return respond(400, { error: "Evento de pago inválido." });
}
