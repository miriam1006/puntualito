import { after } from "next/server";
import { z } from "zod";
import { ApiError, fail, jsonBody, merchantAccess, ok, sameOrigin } from "@/lib/api";
import { notifyDueCreated } from "@/lib/whatsapp-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DUE_FIELDS = "id,concept,amount_cents,status,due_date,public_token,paid_at,created_at,customers(id,name,phone)";

export async function GET() {
  try {
    const { admin, merchant } = await merchantAccess();
    const { data, error } = await admin.from("dues").select(DUE_FIELDS)
      .eq("merchant_id", merchant.id).order("created_at", { ascending: false }).limit(200);
    if (error) throw new ApiError(503, "No se pudieron consultar los cobros.");
    return ok({ dues: data ?? [] });
  } catch (e) { return fail(e); }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const { user, admin, merchant } = await merchantAccess();
    const input = z.strictObject({
      customer_id: z.uuid().nullable(),
      concept: z.string().trim().min(1).max(100),
      amount_cents: z.number().int().positive().max(100_000_000),
    }).safeParse(await jsonBody(request));
    if (!input.success) throw new ApiError(400, "Revisa el concepto y el monto.");
    const { data, error } = await admin.rpc("create_due", {
      p_merchant_id: merchant.id, p_actor_user_id: user.id, p_customer_id: input.data.customer_id,
      p_concept: input.data.concept, p_amount_cents: input.data.amount_cents,
    });
    if (error) {
      if (error.message.includes("invalid_amount")) throw new ApiError(400, "El monto supera el límite del negocio.");
      if (error.message.includes("customer_not_found")) throw new ApiError(404, "Cliente no encontrado.");
      throw new ApiError(503, "No se pudo crear el cobro.");
    }
    const created = Array.isArray(data) ? data[0] : data;
    const { data: due, error: readError } = await admin.from("dues").select(DUE_FIELDS).eq("id", created.id).single();
    if (readError || !due) throw new ApiError(503, "El cobro se creó; recarga para verlo.");
    if (input.data.customer_id) after(() => notifyDueCreated(created.id));
    return ok({ due }, 201);
  } catch (e) { return fail(e); }
}
