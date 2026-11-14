import { z } from "zod";
import { ApiError, fail, jsonBody, merchantAccess, ok, sameOrigin } from "@/lib/api";
import { isValidPlanDay } from "@/lib/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLAN_FIELDS = "id,concept,amount_cents,period,day_of_period,next_due_date,active,created_at,customers(id,name)";

export async function GET() {
  try {
    const { admin, merchant } = await merchantAccess();
    const { data, error } = await admin.from("plans").select(PLAN_FIELDS)
      .eq("merchant_id", merchant.id).eq("active", true).order("next_due_date").limit(500);
    if (error) throw new ApiError(503, "No se pudieron consultar los cobros programados.");
    return ok({ plans: data ?? [] });
  } catch (e) { return fail(e); }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const { user, admin, merchant } = await merchantAccess();
    const input = z.strictObject({
      customer_id: z.uuid(),
      concept: z.string().trim().min(1).max(100),
      amount_cents: z.number().int().positive().max(100_000_000),
      period: z.enum(["weekly", "monthly"]),
      day: z.number().int(),
      start_today: z.boolean(),
    }).safeParse(await jsonBody(request));
    if (!input.success || !isValidPlanDay(input.data.period, input.data.day)) {
      throw new ApiError(400, "Revisa cliente, concepto, monto y día del cobro.");
    }
    const { data, error } = await admin.rpc("create_plan", {
      p_merchant_id: merchant.id, p_actor_user_id: user.id, p_customer_id: input.data.customer_id,
      p_concept: input.data.concept, p_amount_cents: input.data.amount_cents,
      p_period: input.data.period, p_day: input.data.day, p_start_today: input.data.start_today,
    });
    if (error) {
      if (error.message.includes("invalid_amount")) throw new ApiError(400, "El monto supera el límite del negocio.");
      if (error.message.includes("customer_not_found")) throw new ApiError(404, "Cliente no encontrado.");
      throw new ApiError(503, "No se pudo crear el cobro programado.");
    }
    const created = Array.isArray(data) ? data[0] : data;
    const { data: plan, error: readError } = await admin.from("plans").select(PLAN_FIELDS).eq("id", created.id).single();
    if (readError || !plan) throw new ApiError(503, "El cobro programado se creó; recarga para verlo.");
    return ok({ plan }, 201);
  } catch (e) { return fail(e); }
}
