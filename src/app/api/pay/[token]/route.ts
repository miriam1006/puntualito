import { ApiError, fail, ok, publicAttempt } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Estado público de un adeudo. Solo expone lo que el pagador necesita ver. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    if (!/^[0-9a-f]{64}$/.test(token)) throw new ApiError(404, "Este cobro no existe.");
    const admin = createAdminClient();
    const { data: due, error } = await admin.from("dues")
      .select("id,concept,amount_cents,status,paid_at,merchants(name),customers(phone,active)")
      .eq("public_token", token).maybeSingle();
    if (error) throw new ApiError(503, "No se pudo consultar el cobro.");
    if (!due) throw new ApiError(404, "Este cobro no existe.");
    const merchant = (Array.isArray(due.merchants) ? due.merchants[0] : due.merchants) as { name?: string } | null;
    const customer = (Array.isArray(due.customers) ? due.customers[0] : due.customers) as { phone?: string | null; active?: boolean } | null;
    let attempt = null;
    if (due.status === "open") {
      const { data: live } = await admin.from("attempts")
        .select("kind,status,qr_string,expires_at").eq("due_id", due.id).in("status", ["creating", "pending"]).maybeSingle();
      attempt = publicAttempt(live);
    }
    return ok({
      due: {
        merchant_name: merchant?.name ?? "",
        concept: due.concept,
        amount_cents: due.amount_cents,
        paid_at: due.status === "paid" ? due.paid_at : null,
        // 'review' se muestra al pagador como recibido: el comercio resuelve la diferencia.
        status: due.status === "review" ? "paid" : due.status,
        can_push: Boolean(customer?.active && customer.phone),
        phone_hint: customer?.active && customer.phone ? customer.phone.slice(-2) : null,
      },
      attempt,
    });
  } catch (e) { return fail(e); }
}
