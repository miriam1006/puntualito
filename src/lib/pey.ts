import "server-only";
import { z } from "zod";
import {
  peyPushInputSchema, peyPushResponseSchema, peyQrInputSchema, peyQrResponseSchema,
  peyQrTransactionsSchema, peyTransactionSchema, type PeyTransaction,
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

async function request(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<Response> {
  const apiKey = process.env.PEY_API_KEY;
  if (!apiKey) throw new PeyError("configuration");
  try {
    return await fetch(`https://api.pey.mx${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    // Nunca reintentar automáticamente: Pey pudo crear el cobro antes del timeout.
    throw new PeyError("network");
  }
}

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  const response = await request("POST", path, body);
  if (!response.ok) throw new PeyError("rejected", response.status);
  return response;
}

/** 404 significa que Pey no tiene ese recurso para esta API key: se devuelve null. */
async function get(path: string): Promise<Response | null> {
  const response = await request("GET", path);
  if (response.status === 404) return null;
  if (!response.ok) throw new PeyError("rejected", response.status);
  return response;
}

const peyId = z.string().regex(/^[0-9A-Za-z_-]{1,128}$/);

async function parse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  try { return schema.parse(await response.json()); }
  catch { throw new PeyError("invalid_response", response.status); }
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
  return parse(response, peyQrResponseSchema);
}

/** POST /codi/pn — manda la solicitud de cobro al celular del pagador.
 * Verificado contra docs.pey.mx/openapi.json (2026-10-20): amount en MXN (> 0, máximo 1,000,000),
 * phoneNumber de 10 dígitos, expiration mínimo 360; responde 200 con transactionId (ULID) y codiId. */
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
  return parse(response, peyPushResponseSchema);
}

/** GET /transaction/{id} — para push, el id es el transactionId que devolvió POST /codi/pn. */
export async function getPeyTransaction(id: string): Promise<PeyTransaction | null> {
  const response = await get(`/transaction/${encodeURIComponent(peyId.parse(id))}`);
  return response ? parse(response, peyTransactionSchema) : null;
}

/** GET /transaction/codi/qr/{id} — un QR no es una transacción; el id es el IDC (codiQrId).
 * Solo se lee la primera página (20 más recientes): un QR de Puntualito vence en 10 minutos. */
export async function getPeyQrTransactions(codiQrId: string): Promise<PeyTransaction[] | null> {
  const response = await get(`/transaction/codi/qr/${encodeURIComponent(peyId.parse(codiQrId))}`);
  return response ? (await parse(response, peyQrTransactionsSchema)).items : null;
}
