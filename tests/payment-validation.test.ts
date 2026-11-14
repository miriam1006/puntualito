import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import {
  peyPushInputSchema, peyPushPaymentSchema, peyQrInputSchema, peyQrPaymentSchema, pesosToCents, verifyPeyWebhook,
} from "../src/lib/payment-validation";

test("la firma acepta el body intacto y rechaza alteraciones y entregas viejas", () => {
  const key = Buffer.from("test-only-webhook-signing-key-32-bytes");
  const secret = `whsec_${key.toString("base64")}`;
  const body = '{"type":"test","amount":1}';
  const id = "test-webhook";
  const sign = (time: number) => ({
    "webhook-id": id, "webhook-timestamp": String(time),
    "webhook-signature": `v1,${createHmac("sha256", key).update(`${id}.${time}.${body}`).digest("base64")}`,
  });
  const now = Math.floor(Date.now() / 1000);
  assert.deepEqual(verifyPeyWebhook(body, secret, sign(now)), { type: "test", amount: 1 });
  assert.throws(() => verifyPeyWebhook(body.replace("1}", "2}"), secret, sign(now)));
  assert.throws(() => verifyPeyWebhook(body, secret, sign(now - 601)));
  assert.throws(() => verifyPeyWebhook(body, secret, sign(now + 601)));
});

test("la conversión a centavos conserva precisión", () => {
  assert.equal(pesosToCents(0.01), 1);
  assert.equal(pesosToCents(150), 15000);
  assert.equal(pesosToCents(0.29), 29);
  for (const amount of [0, -1, 0.001, 1.999, NaN, Infinity]) assert.throws(() => pesosToCents(amount));
});

test("las referencias conservan ceros iniciales y rechazan entradas inválidas", () => {
  const base = { amountCents: 1, concept: "Prueba", numRef: "0000123" };
  assert.equal(peyQrInputSchema.parse(base).numRef, "0000123");
  for (const numRef of ["12345678", "12a", "", "-1"]) {
    assert.equal(peyQrInputSchema.safeParse({ ...base, numRef }).success, false);
  }
  assert.equal(peyQrInputSchema.safeParse({ ...base, amountCents: 0.5 }).success, false);
});

test("el push exige un celular de 10 dígitos", () => {
  const base = { amountCents: 1, concept: "Prueba", numRef: "1" };
  assert.equal(peyPushInputSchema.safeParse({ ...base, phone: "5512345678" }).success, true);
  for (const phone of ["525512345678", "551234567", "55 1234 5678", ""]) {
    assert.equal(peyPushInputSchema.safeParse({ ...base, phone }).success, false);
  }
});

test("el evento de QR descarta metadata bancaria y rechaza montos imposibles", () => {
  const payload = { type: "codi.qr.payment_received", amount: 0.01, apiKeyId: "api-key-id",
    codiQrId: "qr-id", concept: "Prueba", datePaid: 1790724818,
    numRef: "1", transactionId: "txn-id", metadata: { clabe: "sensitive" } };
  assert.equal("metadata" in peyQrPaymentSchema.parse(payload), false);
  assert.equal(peyQrPaymentSchema.safeParse({ ...payload, amount: 0.001 }).success, false);
  assert.equal(peyQrPaymentSchema.safeParse({ ...payload, type: "unknown" }).success, false);
  for (const required of ["apiKeyId", "codiQrId", "transactionId", "amount"]) {
    const incomplete: Record<string, unknown> = { ...payload };
    delete incomplete[required];
    assert.equal(peyQrPaymentSchema.safeParse(incomplete).success, false);
  }
});

test("el evento de push sigue el ejemplo oficial y descarta metadata bancaria", () => {
  // Ejemplo de docs.pey.mx/docs/webhooks/codi/pn.
  const payload = { amount: 100, apiKeyId: "01M3QMMR6X9CBVDY1SF3G8QWNW", bankAccountId: "01JBAVWE4NS5TGXHWGMX3KH23Q",
    concept: "(dev) Order 45", datePaid: 1790724758, metadata: { clabe: "000000000000000000", bankCode: 40012 },
    numRef: "4567", transactionId: "01M3QR5E7XHXMNZDEPFH3JAWS0", type: "codi.pn.payment_received" };
  const parsed = peyPushPaymentSchema.parse(payload);
  assert.equal("metadata" in parsed, false);
  assert.equal("bankAccountId" in parsed, false);
  assert.equal(parsed.numRef, "4567");
  for (const required of ["apiKeyId", "numRef", "transactionId", "amount", "datePaid"]) {
    const incomplete: Record<string, unknown> = { ...payload };
    delete incomplete[required];
    assert.equal(peyPushPaymentSchema.safeParse(incomplete).success, false, required);
  }
  assert.equal(peyPushPaymentSchema.safeParse({ ...payload, transactionId: "" }).success, false);
  assert.equal(peyPushPaymentSchema.safeParse({ ...payload, type: "codi.qr.payment_received" }).success, false);
});
