import { z } from "zod";
import { Webhook } from "standardwebhooks";

export function verifyPeyWebhook(rawBody: string, secret: string, headers: {
  "webhook-id": string; "webhook-timestamp": string; "webhook-signature": string;
}): unknown {
  return new Webhook(secret).verify(rawBody, headers);
}

/** Todos los montos internos son centavos enteros. Nunca se redondea un pago en silencio. */
export function pesosToCents(amount: number): number {
  const cents = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(cents)
    || Math.abs(amount * 100 - cents) > 0.000001) {
    throw new Error("El monto debe ser positivo y tener como máximo dos decimales.");
  }
  return cents;
}

const numRef = z.string().regex(/^[0-9]{1,7}$/);
const amountCents = z.number().int().positive().max(2_147_483_647);
const paidAmount = z.number().positive().refine((value) => {
  try { pesosToCents(value); return true; } catch { return false; }
}, "Monto inválido");

export const peyQrInputSchema = z.object({
  amountCents,
  concept: z.string().trim().min(1).max(100),
  numRef,
});

export const peyQrResponseSchema = z.object({
  id: z.string().min(1).max(128),
  qrString: z.string().min(1).max(32_768),
});

export const peyPushInputSchema = z.object({
  amountCents,
  concept: z.string().trim().min(1).max(100),
  numRef,
  phone: z.string().regex(/^[0-9]{10}$/),
});

export const peyPushResponseSchema = z.object({
  transactionId: z.string().min(1).max(128),
  codiId: z.string().max(64).nullish(),
});

/** Solo se conservan los campos que identifican y validan el pago. `metadata` y
 * `bankAccountId` (que pueden traer la CLABE) se descartan a propósito. */
export const peyQrPaymentSchema = z.object({
  type: z.literal("codi.qr.payment_received"),
  amount: paidAmount,
  apiKeyId: z.string().min(1).max(128),
  codiQrId: z.string().min(1).max(128),
  concept: z.string().max(1000),
  datePaid: z.number().int().positive().max(253_402_300_799),
  numRef,
  transactionId: z.string().min(1).max(128),
});

/** Verificado contra docs.pey.mx/docs/webhooks/codi/pn: mismo contrato que el de QR,
 * sin `codiQrId`. El `transactionId` es el mismo que devuelve POST /codi/pn. */
export const peyPushPaymentSchema = z.object({
  type: z.literal("codi.pn.payment_received"),
  amount: paidAmount,
  apiKeyId: z.string().min(1).max(128),
  concept: z.string().max(1000),
  datePaid: z.number().int().positive().max(253_402_300_799),
  numRef,
  transactionId: z.string().min(1).max(128),
});

/** GET /transaction/{id} y cada elemento de GET /transaction/codi/qr/{id}.
 * `metadata` (puede traer la CLABE) se descarta igual que en los webhooks. */
export const peyTransactionSchema = z.object({
  id: z.string().min(1).max(128),
  status: z.string().min(1).max(32),
  amount: paidAmount,
  paymentMethod: z.string().max(32).nullish(),
  payableType: z.string().max(32).nullish(),
  datePaid: z.number().int().positive().max(253_402_300_799).nullish(),
});

export const peyQrTransactionsSchema = z.object({
  items: z.array(peyTransactionSchema).max(100),
  nextToken: z.string().max(4096).nullish(),
});

export type PeyQrPayment = z.infer<typeof peyQrPaymentSchema>;
export type PeyPushPayment = z.infer<typeof peyPushPaymentSchema>;
export type PeyTransaction = z.infer<typeof peyTransactionSchema>;
