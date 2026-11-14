import { access, fail, ok } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { user, merchant } = await access();
    return ok({
      email: user.email ?? "",
      merchant: merchant ? { id: merchant.id, name: merchant.name, max_amount_cents: merchant.max_amount_cents } : null,
    });
  } catch (e) { return fail(e); }
}
