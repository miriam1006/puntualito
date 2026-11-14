/** Cliente mínimo de WhatsApp Cloud API (Graph API). Solo se usa desde el servidor:
 * lee el token de process.env. `fetchImpl` existe para las pruebas; nunca se llama a Meta en ellas. */

export type WhatsAppConfig = {
  phoneNumberId: string;
  accessToken: string;
  graphVersion: string;
  language: string;
  templates: { newDue?: string; reminder?: string; paymentReceived?: string };
};

type Env = Record<string, string | undefined>;
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Devuelve null si falta el número o el token: quien llama hace no-op y queda el respaldo wa.me. */
export function whatsappConfig(env: Env = process.env): WhatsAppConfig | null {
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const accessToken = env.WHATSAPP_ACCESS_TOKEN?.trim();
  if (!phoneNumberId || !/^[0-9]{5,30}$/.test(phoneNumberId) || !accessToken) return null;
  const clean = (value: string | undefined) => value?.trim() || undefined;
  return {
    phoneNumberId,
    accessToken,
    graphVersion: clean(env.WHATSAPP_GRAPH_VERSION) ?? "v23.0",
    language: clean(env.WHATSAPP_TEMPLATE_LANGUAGE) ?? "es_MX",
    templates: {
      newDue: clean(env.WHATSAPP_TEMPLATE_NEW_DUE),
      reminder: clean(env.WHATSAPP_TEMPLATE_REMINDER),
      paymentReceived: clean(env.WHATSAPP_TEMPLATE_PAYMENT_RECEIVED),
    },
  };
}

export class WhatsAppError extends Error {
  constructor(public readonly code: "network" | "rejected" | "invalid_response",
    public readonly httpStatus?: number, public readonly metaCode?: string, public readonly metaTitle?: string) {
    super("No se pudo completar la solicitud con WhatsApp.");
    this.name = "WhatsAppError";
  }
}

/** Celular mexicano de 10 dígitos al formato internacional que acepta Cloud API. */
export function toWhatsAppNumber(phone: string): string {
  if (!/^[0-9]{10}$/.test(phone)) throw new Error("invalid_phone");
  return `52${phone}`;
}

/** Meta rechaza parámetros de plantilla con saltos de línea, tabuladores o más de 4 espacios seguidos. */
export function templateParam(value: string, max = 100): string {
  const text = value.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max);
  return text || "-";
}

export const BUTTON_ACTIONS = ["pay_qr", "pay_later"] as const;
export type ButtonAction = (typeof BUTTON_ACTIONS)[number];

export function buttonPayload(action: ButtonAction, dueId: string): string {
  return `${action}:${dueId}`;
}

export type DueTemplateInput = {
  to: string; template: string; language: string;
  customerName: string; merchantName: string; concept: string; amount: string;
  publicToken: string; dueId: string;
};

/** Plantilla de cobro (nuevo o recordatorio). Debe estar registrada en Meta con:
 * cuerpo {{1}} cliente, {{2}} negocio, {{3}} concepto, {{4}} monto; botón 0 URL "Pagar ahora"
 * (https://DOMINIO/pagar/{{1}}); botón 1 respuesta rápida "Más tarde"; botón 2 respuesta rápida "Prefiero QR". */
export function dueTemplatePayload(input: DueTemplateInput) {
  if (!/^[0-9a-f]{64}$/.test(input.publicToken)) throw new Error("invalid_token");
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toWhatsAppNumber(input.to),
    type: "template",
    template: {
      name: input.template,
      language: { code: input.language },
      components: [
        {
          type: "body",
          parameters: [input.customerName, input.merchantName, input.concept, input.amount]
            .map(text => ({ type: "text", text: templateParam(text) })),
        },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: input.publicToken }] },
        { type: "button", sub_type: "quick_reply", index: "1",
          parameters: [{ type: "payload", payload: buttonPayload("pay_later", input.dueId) }] },
        { type: "button", sub_type: "quick_reply", index: "2",
          parameters: [{ type: "payload", payload: buttonPayload("pay_qr", input.dueId) }] },
      ],
    },
  };
}

/** Plantilla "Pago recibido": cuerpo {{1}} concepto, {{2}} monto, {{3}} negocio. Sin botones. */
export function paymentReceivedTemplatePayload(input: {
  to: string; template: string; language: string; concept: string; amount: string; merchantName: string;
}) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toWhatsAppNumber(input.to),
    type: "template",
    template: {
      name: input.template,
      language: { code: input.language },
      components: [{
        type: "body",
        parameters: [input.concept, input.amount, input.merchantName].map(text => ({ type: "text", text: templateParam(text) })),
      }],
    },
  };
}

/** Texto libre: Meta solo lo entrega dentro de las 24 h posteriores al último mensaje del cliente. */
export function textPayload(to: string, body: string) {
  return {
    messaging_product: "whatsapp", recipient_type: "individual", to: toWhatsAppNumber(to),
    type: "text", text: { body: body.slice(0, 4096), preview_url: false },
  };
}

export function imagePayload(to: string, mediaId: string, caption: string) {
  return {
    messaging_product: "whatsapp", recipient_type: "individual", to: toWhatsAppNumber(to),
    type: "image", image: { id: mediaId, caption: caption.slice(0, 1024) },
  };
}

async function graph(config: WhatsAppConfig, path: string, body: BodyInit, json: boolean, fetchImpl: FetchLike) {
  let response: Response;
  try {
    response = await fetchImpl(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.accessToken}`, ...(json ? { "Content-Type": "application/json" } : {}) },
      body,
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new WhatsAppError("network");
  }
  const data = await response.json().catch(() => null) as Record<string, any> | null;
  if (!response.ok) {
    const error = data?.error as { code?: unknown; message?: unknown; error_user_title?: unknown } | undefined;
    throw new WhatsAppError("rejected", response.status,
      error?.code !== undefined ? String(error.code).slice(0, 64) : undefined,
      typeof error?.error_user_title === "string" ? error.error_user_title.slice(0, 256)
        : typeof error?.message === "string" ? error.message.slice(0, 256) : undefined);
  }
  return data;
}

/** POST /{phone-number-id}/messages. Devuelve el wamid que usarán los webhooks de estado. */
export async function sendMessage(config: WhatsAppConfig, payload: Record<string, unknown>, fetchImpl: FetchLike = fetch) {
  const data = await graph(config, "messages", JSON.stringify(payload), true, fetchImpl);
  const id = data?.messages?.[0]?.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 256) throw new WhatsAppError("invalid_response");
  return { waMessageId: id };
}

export function sendTemplate(config: WhatsAppConfig,
  payload: ReturnType<typeof dueTemplatePayload> | ReturnType<typeof paymentReceivedTemplatePayload>,
  fetchImpl: FetchLike = fetch) {
  return sendMessage(config, payload, fetchImpl);
}

export function sendText(config: WhatsAppConfig, to: string, body: string, fetchImpl: FetchLike = fetch) {
  return sendMessage(config, textPayload(to, body), fetchImpl);
}

/** Sube la imagen a Meta (no requiere URL pública) y la manda con su media id. */
export async function sendImage(config: WhatsAppConfig, to: string, png: Uint8Array, caption: string, fetchImpl: FetchLike = fetch) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", "image/png");
  form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "cobro-codi.png");
  const data = await graph(config, "media", form, false, fetchImpl);
  const mediaId = data?.id;
  if (typeof mediaId !== "string" || mediaId.length === 0) throw new WhatsAppError("invalid_response");
  return sendMessage(config, imagePayload(to, mediaId, caption), fetchImpl);
}
