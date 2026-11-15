import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  buttonsPayload, dueTemplatePayload, sendImage, sendText, templateParam, whatsappConfig, WhatsAppError, type WhatsAppConfig,
} from "../src/lib/whatsapp";
import {
  buttonActionFromText, parseButtonPayload, parseWhatsAppWebhook, verifyHandshake, verifyMetaSignature,
} from "../src/lib/whatsapp-webhook";

const SECRET = "test_app_secret";
const PHONE_ID = "123456789012345";
const DUE_ID = "6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5";
const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const config: WhatsAppConfig = {
  phoneNumberId: PHONE_ID, accessToken: "test-token", graphVersion: "v23.0", language: "es_MX",
  templates: { newDue: "cobro_nuevo" },
};

function webhook(value: Record<string, unknown>, phoneNumberId = PHONE_ID) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { display_phone_number: "15550000000", phone_number_id: phoneNumberId }, ...value,
    } }] }],
  };
}

test("verifica X-Hub-Signature-256 sobre el body crudo", () => {
  const body = JSON.stringify(webhook({ statuses: [] }));
  assert.equal(verifyMetaSignature(body, sign(body), SECRET), true);
  assert.equal(verifyMetaSignature(Buffer.from(body), sign(body).toUpperCase().replace("SHA256=", "sha256="), SECRET), true);
  assert.equal(verifyMetaSignature(body + " ", sign(body), SECRET), false, "body alterado");
  assert.equal(verifyMetaSignature(body, sign(body, "otro"), SECRET), false, "otro secreto");
  assert.equal(verifyMetaSignature(body, null, SECRET), false);
  assert.equal(verifyMetaSignature(body, "sha1=abc", SECRET), false);
  assert.equal(verifyMetaSignature(body, sign(body).slice(0, -2), SECRET), false, "firma corta");
  assert.equal(verifyMetaSignature(body, sign(body, ""), ""), false, "sin secreto nunca pasa");
  // Reserializar cambia los bytes: la firma solo vale para el body tal como llegó.
  const spaced = JSON.stringify(JSON.parse(body), null, 2);
  assert.equal(verifyMetaSignature(spaced, sign(body), SECRET), false);
});

test("handshake GET devuelve el challenge solo con el token correcto", () => {
  const params = (mode: string, token: string) =>
    new URLSearchParams({ "hub.mode": mode, "hub.verify_token": token, "hub.challenge": "1158201444" });
  assert.equal(verifyHandshake(params("subscribe", "verify-me"), "verify-me"), "1158201444");
  assert.equal(verifyHandshake(params("subscribe", "nope"), "verify-me"), null);
  assert.equal(verifyHandshake(params("unsubscribe", "verify-me"), "verify-me"), null);
  assert.equal(verifyHandshake(params("subscribe", ""), ""), null);
});

test("parsea respuestas de botón de plantilla, interactivas y texto", () => {
  const events = parseWhatsAppWebhook(webhook({
    contacts: [{ wa_id: "5215512345678", profile: { name: "Ana" } }],
    messages: [
      { id: "wamid.IN1", from: "5215512345678", timestamp: "1763150000", type: "button",
        context: { from: "15550000000", id: "wamid.OUT1" }, button: { payload: `pay_qr:${DUE_ID}`, text: "Prefiero QR" } },
      { id: "wamid.IN2", from: "525512345678", timestamp: "1763150001", type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: `pay_later:${DUE_ID}`, title: "Más tarde" } } },
      { id: "wamid.IN3", from: "5215512345678", timestamp: "1763150002", type: "text", text: { body: "hola" } },
      { id: "wamid.IN4", from: "14155550000", timestamp: "1763150003", type: "sticker", sticker: { id: "x" } },
    ],
  }), PHONE_ID);
  assert.equal(events.length, 4);
  assert.deepEqual(events[0], {
    type: "message", waMessageId: "wamid.IN1", phone: "5512345678", receivedAt: new Date(1763150000 * 1000),
    contextId: "wamid.OUT1", kind: "button", text: "Prefiero QR", buttonPayload: `pay_qr:${DUE_ID}`,
  });
  assert.equal(events[1].type === "message" && events[1].kind, "interactive");
  assert.equal(events[1].type === "message" && events[1].phone, "5512345678");
  assert.equal(events[1].type === "message" && events[1].buttonPayload, `pay_later:${DUE_ID}`);
  assert.equal(events[2].type === "message" && events[2].text, "hola");
  assert.equal(events[3].type === "message" && events[3].kind, "unsupported");
  assert.equal(events[3].type === "message" && events[3].phone, null, "número no mexicano");
});

test("parsea estados de entrega, incluidos errores, e ignora otros números", () => {
  const events = parseWhatsAppWebhook(webhook({
    statuses: [
      { id: "wamid.OUT1", status: "delivered", timestamp: "1763150010", recipient_id: "5215512345678" },
      { id: "wamid.OUT2", status: "failed", timestamp: "1763150011", recipient_id: "5215512345678",
        errors: [{ code: 131030, title: "Recipient phone number not in allowed list" }] },
      { id: "wamid.OUT3", status: "deleted", timestamp: "1763150012" },
    ],
  }), PHONE_ID);
  assert.deepEqual(events, [
    { type: "status", waMessageId: "wamid.OUT1", status: "delivered", at: new Date(1763150010 * 1000), errorCode: null, errorTitle: null },
    { type: "status", waMessageId: "wamid.OUT2", status: "failed", at: new Date(1763150011 * 1000),
      errorCode: "131030", errorTitle: "Recipient phone number not in allowed list" },
  ]);
  assert.deepEqual(parseWhatsAppWebhook(webhook({ statuses: [{ id: "x", status: "read", timestamp: "1" }] }, "999"), PHONE_ID), []);
  assert.throws(() => parseWhatsAppWebhook({ object: "page", entry: [] }));
  assert.throws(() => parseWhatsAppWebhook(webhook({ messages: [{ id: "x", from: "abc", timestamp: "1", type: "text" }] })));
});

test("payload de botones: solo acciones conocidas con id de adeudo", () => {
  assert.deepEqual(parseButtonPayload(`pay_qr:${DUE_ID}`), { action: "pay_qr", dueId: DUE_ID });
  assert.deepEqual(parseButtonPayload(`pay_later:${DUE_ID}`), { action: "pay_later", dueId: DUE_ID });
  assert.deepEqual(parseButtonPayload(`pay_now:${DUE_ID}`), { action: "pay_now", dueId: DUE_ID });
  for (const bad of [null, "", "pay_qr", `pay_push:${DUE_ID}`, `pay_qr:${DUE_ID}x`, "pay_qr:../../x"]) {
    assert.equal(parseButtonPayload(bad), null, String(bad));
  }
  assert.equal(buttonActionFromText("Prefiero QR"), "pay_qr");
  assert.equal(buttonActionFromText(" mas tarde "), "pay_later");
  assert.equal(buttonActionFromText("Más tarde"), "pay_later");
  assert.equal(buttonActionFromText("Pagar ahora"), "pay_now");
  assert.equal(buttonActionFromText("pagar"), null);
});

test("respuesta con botones: ids con el adeudo y títulos válidos para WhatsApp", () => {
  const payload = buttonsPayload("5512345678", "¿No te llegó?", DUE_ID, ["pay_now", "pay_qr"]);
  assert.equal(payload.to, "525512345678");
  assert.equal(payload.type, "interactive");
  assert.deepEqual(payload.interactive.action.buttons, [
    { type: "reply", reply: { id: `pay_now:${DUE_ID}`, title: "Pagar ahora" } },
    { type: "reply", reply: { id: `pay_qr:${DUE_ID}`, title: "Prefiero QR" } },
  ]);
  for (const button of payload.interactive.action.buttons) assert.ok(button.reply.title.length <= 20);
});

test("configuración: sin número o token es no-op", () => {
  assert.equal(whatsappConfig({}), null);
  assert.equal(whatsappConfig({ WHATSAPP_PHONE_NUMBER_ID: PHONE_ID }), null);
  assert.equal(whatsappConfig({ WHATSAPP_PHONE_NUMBER_ID: "abc", WHATSAPP_ACCESS_TOKEN: "t" }), null);
  const c = whatsappConfig({ WHATSAPP_PHONE_NUMBER_ID: PHONE_ID, WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_TEMPLATE_NEW_DUE: "cobro_nuevo" });
  assert.equal(c?.language, "es_MX");
  assert.equal(c?.templates.newDue, "cobro_nuevo");
  assert.equal(c?.templates.paymentReceived, undefined);
});

test("plantilla de cobro: tres respuestas rápidas con el adeudo, sin link", () => {
  const payload = dueTemplatePayload({
    to: "5512345678", template: "cobro_nuevo", language: "es_MX", customerName: "Ana\nLópez",
    merchantName: "Gimnasio", concept: "Mensualidad", amount: "$600.00", dueId: DUE_ID,
  });
  assert.equal(payload.to, "525512345678");
  const [body, now, later, qr] = payload.template.components;
  assert.deepEqual(body.parameters.map(p => "text" in p ? p.text : null), ["Ana López", "Gimnasio", "Mensualidad", "$600.00"]);
  assert.deepEqual(now, { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `pay_now:${DUE_ID}` }] });
  assert.deepEqual(later.parameters, [{ type: "payload", payload: `pay_later:${DUE_ID}` }]);
  assert.deepEqual(qr.parameters, [{ type: "payload", payload: `pay_qr:${DUE_ID}` }]);
  assert.ok(!JSON.stringify(payload).includes("/pagar/"));
  assert.throws(() => dueTemplatePayload({
    to: "5512345678", template: "t", language: "es_MX", customerName: "", merchantName: "", concept: "", amount: "",
    dueId: "../x" }));
  assert.equal(templateParam("  a    b\t\tc  "), "a b c");
  assert.equal(templateParam(""), "-");
});

type Call = { url: string; init: RequestInit };
function mockMeta(responses: Array<[number, unknown]>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const [status, body] = responses.shift() ?? [500, {}];
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { calls, fetchImpl };
}

test("envía texto a la Graph API y devuelve el wamid (Meta simulado)", async () => {
  const meta = mockMeta([[200, { messaging_product: "whatsapp", messages: [{ id: "wamid.OK" }] }]]);
  const result = await sendText(config, "5512345678", "Hola", meta.fetchImpl);
  assert.equal(result.waMessageId, "wamid.OK");
  assert.equal(meta.calls[0].url, `https://graph.facebook.com/v23.0/${PHONE_ID}/messages`);
  assert.equal((meta.calls[0].init.headers as Record<string, string>).Authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(String(meta.calls[0].init.body)), {
    messaging_product: "whatsapp", recipient_type: "individual", to: "525512345678",
    type: "text", text: { body: "Hola", preview_url: false },
  });
});

test("sube la imagen del QR y la manda por media id (Meta simulado)", async () => {
  const meta = mockMeta([[200, { id: "MEDIA1" }], [200, { messages: [{ id: "wamid.IMG" }] }]]);
  const result = await sendImage(config, "5512345678", new Uint8Array([137, 80, 78, 71]), "QR", meta.fetchImpl);
  assert.equal(result.waMessageId, "wamid.IMG");
  assert.match(meta.calls[0].url, /\/media$/);
  assert.ok(meta.calls[0].init.body instanceof FormData);
  assert.deepEqual(JSON.parse(String(meta.calls[1].init.body)).image, { id: "MEDIA1", caption: "QR" });
});

test("errores de Meta conservan el código para el panel", async () => {
  const meta = mockMeta([[400, { error: { message: "(#131030) Recipient not in allowed list", code: 131030 } }]]);
  await assert.rejects(sendText(config, "5512345678", "x", meta.fetchImpl), (e: unknown) =>
    e instanceof WhatsAppError && e.code === "rejected" && e.httpStatus === 400 && e.metaCode === "131030");
  const broken = mockMeta([[200, { messages: [] }]]);
  await assert.rejects(sendText(config, "5512345678", "x", broken.fetchImpl), (e: unknown) =>
    e instanceof WhatsAppError && e.code === "invalid_response");
  const offline = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(sendText(config, "5512345678", "x", offline), (e: unknown) =>
    e instanceof WhatsAppError && e.code === "network");
});
