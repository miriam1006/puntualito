import { z } from "zod";
import { ApiError, fail, merchantAccess, ok, sameOrigin } from "@/lib/api";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    const { id } = await params;
    if (!z.uuid().safeParse(id).success) throw new ApiError(400, "Identificador inválido.");
    const { user, admin, merchant } = await merchantAccess();
    const { error } = await admin.rpc("deactivate_plan", { p_plan_id: id, p_merchant_id: merchant.id, p_actor_user_id: user.id });
    if (error) {
      if (error.message.includes("plan_not_found")) throw new ApiError(404, "Cobro programado no encontrado.");
      throw new ApiError(503, "No se pudo detener el cobro programado.");
    }
    return ok({ ok: true });
  } catch (e) { return fail(e); }
}
