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

/** POR VERIFICAR contra docs.pey.mx: los campos del evento de push salen de notas de
 * otros equipos, no de la referencia oficial. Por eso `apiKeyId`, `concept` y `numRef`
 * son opcionales aquí; la firma del webhook ya autentica la API key. */
export const peyPushPaymentSchema = z.object({
  type: z.literal("codi.pn.payment_received"),
  amount: paidAmount,
  apiKeyId: z.string().min(1).max(128).nullish(),
  concept: z.string().max(1000).nullish(),
  datePaid: z.number().int().positive().max(253_402_300_799),
  numRef: numRef.nullish(),
  transactionId: z.string().min(1).max(128),
});

export type PeyQrPayment = z.infer<typeof peyQrPaymentSchema>;
export type PeyPushPayment = z.infer<typeof peyPushPaymentSchema>;
