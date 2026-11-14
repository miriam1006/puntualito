import "server-only";
import { ApiError } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { createPeyPush, createPeyQr, PeyError } from "@/lib/pey";

const RPC_ERRORS: Record<string, [number, string]> = {
  due_not_found: [404, "Este cobro no existe."],
  invalid_attempt_request: [400, "Solicitud inválida."],
  push_unavailable: [409, "Este cobro no tiene un celular registrado. Usa el código QR."],
  rate_limited: [429, "Hay demasiadas solicitudes en este momento. Espera un minuto."],
  reference_exhausted: [503, "El negocio agotó sus referencias de cobro."],
};

function rpcFailure(message: string | undefined): ApiError {
  for (const [code, [status, text]] of Object.entries(RPC_ERRORS)) {
    if (message?.includes(code)) return new ApiError(status, text);
  }
  return new ApiError(503, "No se pudo preparar el cobro. Intenta de nuevo.");
}

/** Devuelve el intento vivo del adeudo o crea uno nuevo en Pey.
 * Regla central: un solo intento vivo por adeudo y una sola llamada a Pey por intento. */
export async function openAttempt(token: string, kind: "qr" | "push") {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("open_attempt", { p_token: token, p_kind: kind });
  if (error || !data) throw rpcFailure(error?.message);
  const attempt = data.attempt as Record<string, any> | null;
  if (!attempt || !data.created) return { dueStatus: data.due_status as string, attempt };

  const { data: claimed, error: claimError } = await admin.rpc("claim_attempt_creation", { p_attempt_id: attempt.id });
  if (claimError) throw new ApiError(503, "No se pudo iniciar el cobro.");
  const claim = Array.isArray(claimed) ? claimed[0] : claimed;
  // Otra petición ya está creando este intento: quien consulta lo verá al terminar.
  if (!claim?.id) return { dueStatus: data.due_status as string, attempt };

  try {
    const args = kind === "qr"
      ? await createPeyQr({ amountCents: attempt.amount_cents, concept: data.concept, numRef: attempt.num_ref })
        .then(qr => ({ p_attempt_id: attempt.id, p_pey_ref: qr.id, p_qr_string: qr.qrString, p_codi_id: null }))
      : await createPeyPush({ amountCents: attempt.amount_cents, concept: data.concept, numRef: attempt.num_ref, phone: data.phone })
        .then(push => ({ p_attempt_id: attempt.id, p_pey_ref: push.transactionId, p_qr_string: null, p_codi_id: push.codiId ?? null }));
    let finalized = await admin.rpc("finalize_attempt", args);
    // Repetir la misma escritura es seguro. Nunca se repite la llamada a Pey.
    if (finalized.error) finalized = await admin.rpc("finalize_attempt", args);
    if (finalized.error) throw new ApiError(503, "El cobro se creó pero no se pudo guardar. Espera unos minutos antes de intentar otra vez.");
    const saved = Array.isArray(finalized.data) ? finalized.data[0] : finalized.data;
    return { dueStatus: data.due_status as string, attempt: saved as Record<string, any> };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof PeyError) {
      const definite = e.code === "over_limit" || e.code === "configuration"
        || (e.code === "rejected" && e.httpStatus !== undefined && e.httpStatus >= 400 && e.httpStatus < 500);
      if (definite) {
        // Pey no creó nada: se libera el adeudo para poder intentar de nuevo.
        await admin.rpc("fail_attempt", { p_attempt_id: attempt.id, p_code: `${e.code}_${e.httpStatus ?? ""}` });
        if (e.code === "over_limit") throw new ApiError(409, "El monto supera el tope de pruebas configurado (PEY_MAX_AMOUNT_CENTS).");
        if (e.code === "configuration") throw new ApiError(503, "Falta configurar Pey en el servidor.");
        throw new ApiError(502, kind === "push"
          ? "No se pudo enviar el cobro al celular. Prueba con el código QR."
          : "Pey rechazó la solicitud. Intenta de nuevo.");
      }
    }
    // Resultado incierto (timeout o 5xx): el intento queda reservado hasta vencer para no duplicar cobros.
    throw new ApiError(503, "No sabemos si el cobro se creó. Espera unos minutos antes de intentar otra vez.");
  }
}
