import { z } from "zod";
import { ApiError, fail, merchantAccess, ok, sameOrigin } from "@/lib/api";
import { loadDue, payNowReply } from "@/lib/chat-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** "Cobrar ahora" desde el panel: manda el push CoDi al celular del cliente sin esperar a que
 * toque el botón en WhatsApp. Es el mismo intento que "Pagar ahora" (uno vivo por adeudo). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    const { id } = await params;
    if (!z.uuid().safeParse(id).success) throw new ApiError(400, "Identificador inválido.");
    const { admin, merchant } = await merchantAccess();
    const due = await loadDue(admin, id);
    if (!due || due.merchant_id !== merchant.id) throw new ApiError(404, "Cobro no encontrado.");
    if (!due.customer?.phone) throw new ApiError(400, "Este cobro no tiene un cliente con celular. Usa «Mostrar QR».");
    if (due.status !== "open") throw new ApiError(409, "Este cobro ya no está pendiente.");
    const reply = await payNowReply(due);
    // payNowReply le habla al cliente; aquí se traduce para el negocio.
    const sent = reply.text.startsWith("Listo.") || reply.text.startsWith("Estamos enviando");
    const text = sent
      ? `Notificación CoDi enviada a ${due.customer.name} (celular terminación ${due.customer.phone.slice(-4)}). Tiene unos minutos para autorizarla en la app de su banco.`
      : reply.text.startsWith("Ya te mandamos un código QR")
        ? "Hay un QR vigente para este cobro. Cuando venza podrás mandar la notificación."
        : reply.text.split(" Revisa que tengas")[0];
    return ok({ sent, text });
  } catch (e) { return fail(e); }
}
