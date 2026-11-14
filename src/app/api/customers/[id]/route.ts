import { z } from "zod";
import { ApiError, fail, jsonBody, merchantAccess, ok, sameOrigin } from "@/lib/api";
import { normalizeMxPhone } from "@/lib/phone";

export const runtime = "nodejs";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    const { id } = await params;
    if (!z.uuid().safeParse(id).success) throw new ApiError(400, "Identificador inválido.");
    const { user, admin, merchant } = await merchantAccess();
    const input = z.strictObject({
      name: z.string().trim().min(1).max(100),
      phone: z.string().max(30),
      whatsapp_opt_in: z.boolean(),
    }).safeParse(await jsonBody(request));
    if (!input.success) throw new ApiError(400, "Revisa el nombre y el celular.");
    const phone = input.data.phone.trim() ? normalizeMxPhone(input.data.phone) : null;
    if (input.data.phone.trim() && !phone) throw new ApiError(400, "El celular debe tener 10 dígitos.");
    const { data, error } = await admin.rpc("update_customer", {
      p_customer_id: id, p_merchant_id: merchant.id, p_actor_user_id: user.id,
      p_name: input.data.name, p_phone: phone, p_whatsapp_opt_in: input.data.whatsapp_opt_in,
    });
    if (error) {
      if (error.message.includes("customer_not_found")) throw new ApiError(404, "Cliente no encontrado.");
      if (error.message.includes("customer_phone_taken")) throw new ApiError(409, "Ya hay un cliente con ese celular.");
      throw new ApiError(503, "No se pudo guardar el cliente.");
    }
    const customer = Array.isArray(data) ? data[0] : data;
    return ok({ customer: {
      id: customer.id, name: customer.name, phone: customer.phone,
      whatsapp_opt_in: customer.whatsapp_opt_in, preferred_channel: customer.preferred_channel,
    } });
  } catch (e) { return fail(e); }
}
