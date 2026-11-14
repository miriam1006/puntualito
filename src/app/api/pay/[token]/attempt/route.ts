import { z } from "zod";
import { ApiError, fail, jsonBody, ok, publicAttempt, sameOrigin } from "@/lib/api";
import { openAttempt } from "@/lib/attempts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** El pagador pide un QR o un push desde el link público.
 * Protección contra abuso: el token es secreto, hay un solo intento vivo por adeudo
 * y el push solo sale al celular que registró el comercio. */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    sameOrigin(request);
    const { token } = await params;
    if (!/^[0-9a-f]{64}$/.test(token)) throw new ApiError(404, "Este cobro no existe.");
    const input = z.strictObject({ kind: z.enum(["qr", "push"]) }).safeParse(await jsonBody(request));
    if (!input.success) throw new ApiError(400, "Solicitud inválida.");
    const result = await openAttempt(token, input.data.kind);
    return ok({
      due_status: result.dueStatus === "review" ? "paid" : result.dueStatus,
      attempt: publicAttempt(result.attempt),
    });
  } catch (e) { return fail(e); }
}
