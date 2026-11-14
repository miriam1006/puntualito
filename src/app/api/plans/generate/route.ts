import { ApiError, fail, merchantAccess, ok, sameOrigin } from "@/lib/api";
import { generateDues } from "@/lib/plans-server";

export const runtime = "nodejs";

/** Botón "Generar cobros ahora": lo mismo que el cron diario, solo para este comercio. */
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const { user, admin, merchant } = await merchantAccess();
    const result = await generateDues(admin, merchant.id, user.id)
      .catch(() => { throw new ApiError(503, "No se pudieron generar los cobros."); });
    return ok({ created: result.created.length, skipped: result.skipped });
  } catch (e) { return fail(e); }
}
