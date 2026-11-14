import "server-only";
import { z } from "zod";
import {
  peyPushInputSchema, peyPushResponseSchema, peyQrInputSchema, peyQrResponseSchema,
} from "./payment-validation";

export class PeyError extends Error {
  constructor(public readonly code: "configuration" | "network" | "rejected" | "invalid_response" | "over_limit",
    public readonly httpStatus?: number) {
    super("No se pudo completar la solicitud con Pey.");
    this.name = "PeyError";
  }
}

/** No hay sandbox: se cobra en producción. Este tope evita cobros grandes por error.
 * Si PEY_MAX_AMOUNT_CENTS no está definido, el tope es 1 centavo. */
function assertWithinLimit(amountCents: number) {
  const configured = Number(process.env.PEY_MAX_AMOUNT_CENTS);
  const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : 1;
  if (amountCents > limit) throw new PeyError("over_limit");
}

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  const apiKey = process.env.PEY_API_KEY;
  if (!apiKey) throw new PeyError("configuration");
  let response: Response;
  try {
    response = await fetch(`https://api.pey.mx${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    // Nunca reintentar automáticamente: Pey pudo crear el cobro antes del timeout.
    throw new PeyError("network");
  }
  if (!response.ok) throw new PeyError("rejected", response.status);
  return response;
}

/** POST /codi/qr — amount en MXN; expiration en segundos (mínimo 360). */
export async function createPeyQr(input: z.input<typeof peyQrInputSchema>) {
  const data = peyQrInputSchema.parse(input);
  assertWithinLimit(data.amountCents);
  const response = await post("/codi/qr", {
    amount: data.amountCents / 100,
    concept: data.concept,
    expiration: 600,
    numRef: data.numRef,
    generateImage: false,
  });
  try { return peyQrResponseSchema.parse(await response.json()); }
  catch { throw new PeyError("invalid_response", response.status); }
}

/** POST /codi/pn — manda la solicitud de cobro al celular del pagador.
 * POR VERIFICAR contra docs.pey.mx/openapi.json: los campos (amount, phoneNumber de 10
 * dígitos, concept, expiration mínimo 360, numRef) y la respuesta (transactionId, codiId)
 * salen de notas de otros equipos del hackatón, no de la referencia oficial. */
export async function createPeyPush(input: z.input<typeof peyPushInputSchema>) {
  const data = peyPushInputSchema.parse(input);
  assertWithinLimit(data.amountCents);
  const response = await post("/codi/pn", {
    amount: data.amountCents / 100,
    phoneNumber: data.phone,
    concept: data.concept,
    expiration: 360,
    numRef: data.numRef,
  });
  try { return peyPushResponseSchema.parse(await response.json()); }
  catch { throw new PeyError("invalid_response", response.status); }
}
