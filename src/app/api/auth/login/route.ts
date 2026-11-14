import { z } from "zod";
import { ApiError, fail, jsonBody, ok, sameOrigin } from "@/lib/api";
import { createSessionClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const input = z.strictObject({
      email: z.string().trim().max(254).pipe(z.email()),
      password: z.string().min(1).max(256),
    }).safeParse(await jsonBody(request));
    if (!input.success) throw new ApiError(400, "Escribe tu correo electrónico y contraseña.");
    const client = await createSessionClient();
    const { data, error } = await client.auth.signInWithPassword({
      email: input.data.email.toLowerCase(), password: input.data.password,
    });
    if (error) {
      if (error.status === 429) throw new ApiError(429, "Demasiados intentos. Espera un momento.");
      if (!error.status || error.status >= 500) throw new ApiError(503, "No se pudo conectar con el servicio de acceso.");
      throw new ApiError(401, "Correo o contraseña incorrectos.");
    }
    if (!data.user) throw new ApiError(401, "Correo o contraseña incorrectos.");
    return ok({ ok: true });
  } catch (e) { return fail(e); }
}
