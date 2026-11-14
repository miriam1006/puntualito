import { fail, ok, sameOrigin } from "@/lib/api";
import { createSessionClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const client = await createSessionClient();
    const { error } = await client.auth.signOut();
    if (error) throw error;
    return ok({ ok: true });
  } catch (e) { return fail(e); }
}
