import { ApiError, fail, merchantAccess, ok } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REVIEW_FIELDS = "id,concept,amount_cents,status,due_date,public_token,paid_at,cancelled_at,created_at,"
  + "review_resolution,review_note,reviewed_at,customers(id,name,phone),"
  + "payment_receipts!payment_receipts_due_id_fkey(transaction_id,amount_cents,paid_at,needs_review,attempts(kind,late_payment))";

export async function GET() {
  try {
    const { admin, merchant } = await merchantAccess();
    const { data, error } = await admin.from("dues").select(REVIEW_FIELDS)
      .eq("merchant_id", merchant.id).eq("status", "review").order("created_at", { ascending: false }).limit(200);
    if (error) throw new ApiError(503, "No se pudieron consultar los cobros por revisar.");
    return ok({ dues: data ?? [] });
  } catch (e) { return fail(e); }
}
