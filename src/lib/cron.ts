import { createHash, timingSafeEqual } from "node:crypto";

/** Vercel Cron manda `Authorization: Bearer <CRON_SECRET>`. Sin secreto configurado, nadie entra. */
export function cronAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header.slice("Bearer ".length)), digest(secret));
}
