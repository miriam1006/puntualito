"use client";
import { useEffect, useState } from "react";
import { clientApi } from "@/lib/client-api";
import type { Session } from "./types";

/** Sesión para las pantallas secundarias: sin comercio, regresa al panel para crearlo. */
export function useMerchantSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    clientApi("/api/session")
      .then((s: Session) => { if (!s.merchant) window.location.assign("/"); else setSession(s); })
      .catch(e => setError(e instanceof Error ? e.message : "No se pudo cargar."));
  }, []);
  return { session, error };
}
