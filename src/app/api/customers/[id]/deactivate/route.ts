import { z } from "zod";
import { ApiError, fail, merchantAccess, ok, sameOrigin } from "@/lib/api";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    const { id } = await params;
    if (!z.uuid().safeParse(id).success) throw new ApiError(400, "Identificador inválido.");
    const { user, admin, merchant } = await merchantAccess();
    const { data, error } = await admin.rpc("deactivate_customer", {
      p_customer_id: id, p_merchant_id: merchant.id, p_actor_user_id: user.id,
    });
    if (error) {
      if (error.message.includes("customer_not_found")) throw new ApiError(404, "Cliente no encontrado.");
      throw new ApiError(503, "No se pudo dar de baja al cliente.");
    }
    return ok({ plans_deactivated: data?.plans_deactivated ?? 0 });
  } catch (e) { return fail(e); }
}
