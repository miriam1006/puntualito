import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { normalizeMxPhone } from "./phone";
import { BUTTON_ACTIONS, type ButtonAction } from "./whatsapp";

/** X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, body crudo) en hex.
 * Se verifica sobre los bytes recibidos, nunca sobre un JSON reserializado. */
export function verifyMetaSignature(rawBody: string | Uint8Array, header: string | null, appSecret: string): boolean {
  if (!appSecret || !header) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const received = Buffer.from(match[1], "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Handshake GET de Meta: devuelve hub.challenge solo si el token coincide. */
export function verifyHandshake(params: URLSearchParams, verifyToken: string): string | null {
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token") ?? "";
  const challenge = params.get("hub.challenge");
  if (!verifyToken || mode !== "subscribe" || !challenge || challenge.length > 256) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  return a.length === b.length && timingSafeEqual(a, b) ? challenge : null;
}

export function parseButtonPayload(payload: string | null | undefined): { action: ButtonAction; dueId: string } | null {
  const match = /^([a-z_]+):([0-9a-f-]{36})$/.exec(payload ?? "");
  if (!match || !(BUTTON_ACTIONS as readonly string[]).includes(match[1])) return null;
  return { action: match[1] as ButtonAction, dueId: match[2] };
}

const short = (max: number) => z.string().min(1).max(max);
const timestamp = z.string().regex(/^[0-9]{1,12}$/);

const messageSchema = z.object({
  id: short(256),
  from: z.string().regex(/^[0-9]{6,20}$/),
  timestamp,
  type: z.string().max(32),
  context: z.object({ id: short(256).optional() }).optional(),
  text: z.object({ body: z.string().max(4096) }).optional(),
  button: z.object({ payload: z.string().max(256).optional(), text: z.string().max(256).optional() }).optional(),
  interactive: z.object({
    type: z.string().max(32),
    button_reply: z.object({ id: z.string().max(256), title: z.string().max(256) }).optional(),
  }).optional(),
});

const statusSchema = z.object({
  id: short(256),
  status: z.string().max(32),
  timestamp,
  recipient_id: z.string().max(32).optional(),
  errors: z.array(z.object({
    code: z.union([z.number(), z.string()]).optional(),
    title: z.string().max(512).optional(),
  })).max(10).optional(),
});

const webhookSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(z.object({
    changes: z.array(z.object({
      field: z.string(),
      value: z.object({
        metadata: z.object({ phone_number_id: z.string() }).optional(),
        messages: z.array(messageSchema).max(100).optional(),
        statuses: z.array(statusSchema).max(100).optional(),
      }),
    })).max(100),
  })).max(100),
});

export type InboundMessage = {
  type: "message";
  waMessageId: string;
  /** Celular de 10 dígitos; null si no es un número mexicano. */
  phone: string | null;
  receivedAt: Date;
  contextId: string | null;
  kind: "text" | "button" | "interactive" | "unsupported";
  text: string | null;
  buttonPayload: string | null;
};

export type StatusUpdate = {
  type: "status";
  waMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  at: Date;
  errorCode: string | null;
  errorTitle: string | null;
};

export type WhatsAppEvent = InboundMessage | StatusUpdate;

const STATUSES = new Set(["sent", "delivered", "read", "failed"]);

/** Extrae mensajes y estados. Ignora otros campos y otros números de la misma cuenta.
 * Lanza si el cuerpo no es un webhook de WhatsApp. */
export function parseWhatsAppWebhook(body: unknown, phoneNumberId?: string): WhatsAppEvent[] {
  const parsed = webhookSchema.parse(body);
  const events: WhatsAppEvent[] = [];
  for (const entry of parsed.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      const value = change.value;
      if (phoneNumberId && value.metadata?.phone_number_id !== phoneNumberId) continue;
      for (const m of value.messages ?? []) {
        const kind = m.type === "text" ? "text" : m.type === "button" ? "button"
          : m.type === "interactive" && m.interactive?.button_reply ? "interactive" : "unsupported";
        events.push({
          type: "message",
          waMessageId: m.id,
          phone: normalizeMxPhone(m.from),
          receivedAt: new Date(Number(m.timestamp) * 1000),
          contextId: m.context?.id ?? null,
          kind,
          text: kind === "text" ? m.text?.body ?? null
            : kind === "button" ? m.button?.text ?? null
            : kind === "interactive" ? m.interactive?.button_reply?.title ?? null : null,
          buttonPayload: kind === "button" ? m.button?.payload ?? null
            : kind === "interactive" ? m.interactive?.button_reply?.id ?? null : null,
        });
      }
      for (const s of value.statuses ?? []) {
        if (!STATUSES.has(s.status)) continue;
        const error = s.errors?.[0];
        events.push({
          type: "status",
          waMessageId: s.id,
          status: s.status as StatusUpdate["status"],
          at: new Date(Number(s.timestamp) * 1000),
          errorCode: error?.code !== undefined ? String(error.code).slice(0, 64) : null,
          errorTitle: error?.title?.slice(0, 256) ?? null,
        });
      }
    }
  }
  return events;
}

/** Si Meta no manda payload (p. ej. botón de una plantilla sin parámetros), se usa el texto del botón. */
export function buttonActionFromText(text: string | null): ButtonAction | null {
  const normalized = (text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  if (normalized === "prefiero qr") return "pay_qr";
  if (normalized === "mas tarde") return "pay_later";
  return null;
}
