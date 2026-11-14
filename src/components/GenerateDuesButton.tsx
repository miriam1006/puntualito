"use client";
import { useState } from "react";
import { clientApi } from "@/lib/client-api";

/** Para la demo: corre en el momento lo que el cron hace una vez al día. */
export function GenerateDuesButton({ onGenerated, className = "secondary" }: {
  onGenerated: () => Promise<void> | void; className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function run() {
    setBusy(true); setMessage(""); setError("");
    try {
      const data = await clientApi("/api/plans/generate", { method: "POST", body: "{}" });
      const created = Number(data.created) || 0;
      setMessage(created === 0 ? "No hay cobros programados para hoy." : created === 1 ? "Se generó 1 cobro." : `Se generaron ${created} cobros.`);
      await onGenerated();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudieron generar los cobros."); }
    finally { setBusy(false); }
  }
  return (
    <div className="generate">
      <button className={className} onClick={run} disabled={busy}>{busy ? "Generando…" : "Generar cobros ahora"}</button>
      {message && <span className="muted" role="status">{message}</span>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
