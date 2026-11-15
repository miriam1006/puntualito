import { z } from "zod";
import { ApiError, fail, jsonBody, ok, sameOrigin } from "@/lib/api";
import { dueMessageText, laterReply, loadDueByToken, payNowReply, qrReply } from "@/lib/chat-flow";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Vista previa del chat de WhatsApp. Usa las mismas respuestas que el webhook de Meta
 * (lib/chat-flow) y el mismo cobro CoDi real; solo cambia que se muestran en pantalla.
 * Expone lo mismo que el link público: negocio, concepto y monto, nunca el nombre del cliente. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const due = await loadDueByToken(createAdminClient(), token);
    if (!due) throw new ApiError(404, "Este cobro no existe.");
    return ok({ message: dueMessageText(due), merchant_name: due.merchantName });
  } catch (e) { return fail(e); }
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    sameOrigin(request);
    const { token } = await params;
    const input = z.strictObject({ action: z.enum(["pay_now", "pay_later", "pay_qr"]) }).safeParse(await jsonBody(request));
    if (!input.success) throw new ApiError(400, "Solicitud inválida.");
    const admin = createAdminClient();
    const due = await loadDueByToken(admin, token);
    if (!due) throw new ApiError(404, "Este cobro no existe.");
    const reply = input.data.action === "pay_now" ? await payNowReply(due)
      : input.data.action === "pay_qr" ? await qrReply(due)
      : await laterReply(admin, due);
    return ok({ reply });
  } catch (e) { return fail(e); }
}
