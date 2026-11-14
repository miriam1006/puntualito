import { z } from "zod";
import { ApiError, fail, jsonBody, merchantAccess, ok, sameOrigin } from "@/lib/api";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    const { id } = await params;
    if (!z.uuid().safeParse(id).success) throw new ApiError(400, "Identificador inválido.");
    const { user, admin, merchant } = await merchantAccess();
    const input = z.strictObject({
      resolution: z.enum(["paid", "refund_needed", "closed"]),
      note: z.string().trim().max(500).nullable(),
    }).safeParse(await jsonBody(request));
    if (!input.success) throw new ApiError(400, "Revisa la resolución y la nota (máximo 500 caracteres).");
    const { error } = await admin.rpc("resolve_due", {
      p_due_id: id, p_merchant_id: merchant.id, p_actor_user_id: user.id,
      p_resolution: input.data.resolution, p_note: input.data.note || null,
    });
    if (error) {
      if (error.message.includes("due_not_found")) throw new ApiError(404, "Cobro no encontrado.");
      if (error.message.includes("invalid_due_state")) throw new ApiError(409, "Este cobro ya no está por revisar.");
      if (error.message.includes("note_required")) throw new ApiError(400, "Escribe cómo vas a devolver el dinero.");
      throw new ApiError(503, "No se pudo resolver el cobro.");
    }
    return ok({ ok: true });
  } catch (e) { return fail(e); }
}
