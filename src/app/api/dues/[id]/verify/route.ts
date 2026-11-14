import { z } from "zod";
import { ApiError, fail, merchantAccess, ok, sameOrigin } from "@/lib/api";
import { getPeyQrTransactions, getPeyTransaction, PeyError } from "@/lib/pey";
import { reconcileAttempts, ReconcileError, type ReconcileAttempt } from "@/lib/reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Conciliación manual ("Verificar pago") para webhooks perdidos: consulta Pey y, si el pago
 * existe, lo registra por process_pey_payment igual que el webhook. Solo lee de Pey; nunca cobra. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    const { id } = await params;
    if (!z.uuid().safeParse(id).success) throw new ApiError(400, "Identificador inválido.");
    const { admin, merchant } = await merchantAccess();

    const apiKeyId = process.env.PEY_API_KEY_ID;
    if (!apiKeyId) throw new ApiError(503, "Falta configurar Pey en el servidor.");
    if (merchant.pey_api_key_id !== apiKeyId) throw new ApiError(409, "La API key de Pey configurada no corresponde a este negocio.");

    const { data: due, error: dueError } = await admin.from("dues").select("id,status")
      .eq("id", id).eq("merchant_id", merchant.id).maybeSingle();
    if (dueError) throw new ApiError(503, "No se pudo consultar el cobro.");
    if (!due) throw new ApiError(404, "Cobro no encontrado.");
    if (due.status !== "open") return ok({ due_status: due.status, payments_found: 0 });

    const { data: attempts, error: attemptsError } = await admin.from("attempts").select("id,kind,pey_ref")
      .eq("due_id", due.id).eq("merchant_id", merchant.id).in("status", ["pending", "expired"])
      .not("pey_ref", "is", null).order("created_at", { ascending: false }).limit(5);
    if (attemptsError) throw new ApiError(503, "No se pudo consultar el cobro.");
    if (!attempts?.length) throw new ApiError(409, "Este cobro todavía no tiene un QR o push creado en Pey.");

    const result = await reconcileAttempts(attempts as ReconcileAttempt[], {
      getTransaction: getPeyTransaction,
      getQrTransactions: getPeyQrTransactions,
      recordPayment: async payment => {
        const { data, error } = await admin.rpc("process_pey_payment", {
          p_webhook_id: payment.webhookId,
          p_payload: payment.payload,
          p_pey_api_key_id: apiKeyId,
          p_kind: payment.kind,
          p_pey_ref: payment.peyRef,
          p_num_ref: null,
          p_transaction_id: payment.transactionId,
          p_amount_cents: payment.amountCents,
          p_paid_at: payment.paidAt,
        });
        if (error || !data) {
          console.error("pey_reconcile_processing_failed", { dueId: due.id, code: error?.code });
          throw new ReconcileError("record_failed");
        }
        console.info("pey_reconcile_processed", { dueId: due.id, outcome: data.outcome });
        return { outcome: String(data.outcome), retry: Boolean(data.retry) };
      },
    });

    const { data: updated } = await admin.from("dues").select("status").eq("id", due.id).maybeSingle();
    return ok({ due_status: updated?.status ?? due.status, payments_found: result.outcomes.length });
  } catch (e) {
    if (e instanceof PeyError) {
      console.warn("pey_reconcile_failed", { code: e.code, httpStatus: e.httpStatus });
      return fail(new ApiError(502, "No se pudo consultar Pey. Intenta de nuevo en un momento."));
    }
    if (e instanceof ReconcileError) {
      console.error("pey_reconcile_failed", { code: e.code });
      return fail(new ApiError(502, e.code === "unexpected_transaction"
        ? "Pey devolvió un pago que no corresponde a este cobro. Revísalo en Pey."
        : "Pey reporta el pago pero no se pudo registrar. Intenta de nuevo."));
    }
    return fail(e);
  }
}
