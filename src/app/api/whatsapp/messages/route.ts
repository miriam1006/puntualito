import { ApiError, fail, merchantAccess, ok } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Historial de WhatsApp del comercio para el panel, agrupado por adeudo en el navegador. */
export async function GET() {
  try {
    const { admin, merchant } = await merchantAccess();
    const { data, error } = await admin.from("whatsapp_messages")
      .select("id,due_id,direction,purpose,kind,status,body,error_code,error_title,status_at,created_at")
      .eq("merchant_id", merchant.id).not("due_id", "is", null)
      .order("created_at", { ascending: false }).limit(500);
    if (error) throw new ApiError(503, "No se pudo consultar WhatsApp.");
    return ok({ messages: data ?? [] });
  } catch (e) { return fail(e); }
}
