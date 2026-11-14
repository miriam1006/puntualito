import { after } from "next/server";
import { whatsappConfig } from "@/lib/whatsapp";
import { handleWhatsAppEvents } from "@/lib/whatsapp-notify";
import { parseWhatsAppWebhook, verifyHandshake, verifyMetaSignature, type WhatsAppEvent } from "@/lib/whatsapp-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY_BYTES = 256 * 1024;
const respond = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function readLimitedBody(request: Request): Promise<Buffer> {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("body_too_large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Verificación de la suscripción en Meta → WhatsApp → Configuración → Webhook. */
export async function GET(request: Request) {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!verifyToken) {
    console.error("whatsapp_webhook_rejected", { reason: "configuration_missing", status: 503 });
    return respond(503, { error: "Webhook sin configurar." });
  }
  const challenge = verifyHandshake(new URL(request.url).searchParams, verifyToken);
  if (!challenge) return respond(403, { error: "Token inválido." });
  return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    console.error("whatsapp_webhook_rejected", { reason: "configuration_missing", status: 503 });
    return respond(503, { error: "Webhook sin configurar." });
  }
  let rawBody: Buffer;
  try { rawBody = await readLimitedBody(request); }
  catch { return respond(413, { error: "Solicitud demasiado grande." }); }
  if (!verifyMetaSignature(rawBody, request.headers.get("x-hub-signature-256"), appSecret)) {
    console.warn("whatsapp_webhook_rejected", { reason: "signature_invalid", status: 401 });
    return respond(401, { error: "Firma inválida." });
  }

  let events: WhatsAppEvent[];
  try {
    events = parseWhatsAppWebhook(JSON.parse(rawBody.toString("utf8")), whatsappConfig()?.phoneNumberId);
  } catch {
    // Firmado pero con otra forma (otro producto o campo): no tiene caso que Meta lo reintente.
    console.info("whatsapp_webhook_ignored", { reason: "unsupported_payload" });
    return respond(200, { received: true, ignored: true });
  }

  try {
    const followUps = await handleWhatsAppEvents(events);
    // Meta espera un 200 rápido; el QR (Pey + subida de imagen) se manda después de responder.
    if (followUps.length > 0) after(async () => { for (const run of followUps) await run(); });
    return respond(200, { received: true });
  } catch {
    console.error("whatsapp_webhook_processing_failed", { events: events.length });
    return respond(500, { error: "No se pudo procesar el evento." });
  }
}
