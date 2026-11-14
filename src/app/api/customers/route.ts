import { z } from "zod";
import { ApiError, fail, jsonBody, merchantAccess, ok, sameOrigin } from "@/lib/api";
import { normalizeMxPhone } from "@/lib/phone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CUSTOMER_FIELDS = "id,name,phone,whatsapp_opt_in,preferred_channel,created_at";

export async function GET() {
  try {
    const { admin, merchant } = await merchantAccess();
    const { data, error } = await admin.from("customers").select(CUSTOMER_FIELDS)
      .eq("merchant_id", merchant.id).eq("active", true).order("name").limit(500);
    if (error) throw new ApiError(503, "No se pudieron consultar los clientes.");
    return ok({ customers: data ?? [] });
  } catch (e) { return fail(e); }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const { admin, merchant } = await merchantAccess();
    const input = z.strictObject({
      name: z.string().trim().min(1).max(100),
      phone: z.string().max(30),
      whatsapp_opt_in: z.boolean(),
    }).safeParse(await jsonBody(request));
    if (!input.success) throw new ApiError(400, "Revisa el nombre y el celular.");
    const phone = input.data.phone.trim() ? normalizeMxPhone(input.data.phone) : null;
    if (input.data.phone.trim() && !phone) throw new ApiError(400, "El celular debe tener 10 dígitos.");
    const { data, error } = await admin.from("customers").insert({
      merchant_id: merchant.id, name: input.data.name, phone, whatsapp_opt_in: input.data.whatsapp_opt_in,
    }).select(CUSTOMER_FIELDS).single();
    if (error) {
      if (error.code === "23505") throw new ApiError(409, "Ya hay un cliente con ese celular.");
      throw new ApiError(503, "No se pudo guardar el cliente.");
    }
    return ok({ customer: data }, 201);
  } catch (e) { return fail(e); }
}
