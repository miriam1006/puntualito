import { z } from "zod";
import { access, ApiError, fail, jsonBody, ok, sameOrigin } from "@/lib/api";

export const runtime = "nodejs";

/** Crea el comercio del usuario autorizado por OWNER_EMAIL y lo liga a la API key del servidor. */
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const { user, admin, merchant } = await access();
    if (merchant) throw new ApiError(409, "Tu comercio ya existe.");
    const apiKeyId = process.env.PEY_API_KEY_ID;
    if (!apiKeyId) throw new ApiError(503, "Falta configurar PEY_API_KEY_ID en el servidor.");
    const input = z.strictObject({ name: z.string().trim().min(1).max(100) }).safeParse(await jsonBody(request));
    if (!input.success) throw new ApiError(400, "Escribe el nombre de tu negocio.");
    const { data, error } = await admin.from("merchants")
      .insert({ owner_user_id: user.id, name: input.data.name, pey_api_key_id: apiKeyId })
      .select("id,name,max_amount_cents").single();
    if (error) {
      if (error.code === "23505") throw new ApiError(409, "Esa API key de Pey ya está ligada a otro comercio.");
      throw new ApiError(503, "No se pudo crear el comercio.");
    }
    return ok({ merchant: data }, 201);
  } catch (e) { return fail(e); }
}
