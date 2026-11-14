"use client";
import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { clientApi } from "@/lib/client-api";
import { formatCents } from "@/lib/phone";

type Due = {
  merchant_name: string; concept: string; amount_cents: number;
  status: "open" | "paid" | "cancelled"; can_push: boolean; phone_hint: string | null;
};
type Attempt = { kind: "qr" | "push"; status: "creating" | "pending"; qr_string: string | null; expires_at: string } | null;

export default function PayClient({ token }: { token: string }) {
  const [due, setDue] = useState<Due | null>(null);
  const [attempt, setAttempt] = useState<Attempt>(null);
  const [qrImage, setQrImage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const data = await clientApi(`/api/pay/${token}`, { publicPage: true });
    setDue(data.due);
    setAttempt(data.attempt);
  }, [token]);

  useEffect(() => { load().catch(() => setMissing(true)); }, [load]);

  // El pago se confirma por webhook en el servidor: aquí solo se consulta el estado.
  useEffect(() => {
    if (!due || due.status !== "open") return;
    const poll = setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 3000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [due, load]);

  const qrString = attempt?.kind === "qr" ? attempt.qr_string : null;
  useEffect(() => {
    if (!qrString) { setQrImage(""); return; }
    QRCode.toDataURL(qrString, { width: 600, margin: 1 }).then(setQrImage).catch(() => setQrImage(""));
  }, [qrString]);

  async function start(kind: "qr" | "push") {
    setBusy(true); setError("");
    try {
      const data = await clientApi(`/api/pay/${token}/attempt`, {
        method: "POST", publicPage: true, body: JSON.stringify({ kind }),
      });
      setAttempt(data.attempt);
      if (data.due_status !== "open") await load();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo preparar el cobro."); }
    finally { setBusy(false); }
  }

  if (missing) return <main className="narrow pay"><section className="card"><h1>Este cobro no existe</h1><p className="muted">Revisa el link o pídele uno nuevo al negocio.</p></section></main>;
  if (!due) return <main className="narrow pay"><p className="muted">Cargando…</p></main>;

  const secondsLeft = attempt ? Math.max(0, Math.floor((Date.parse(attempt.expires_at) - now) / 1000)) : 0;
  const live = attempt && secondsLeft > 0 ? attempt : null;
  const countdown = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`;

  return (
    <main className="narrow pay">
      <section className="card">
        <p className="muted">{due.merchant_name}</p>
        <p className="amount">{formatCents(due.amount_cents)}</p>
        <p>{due.concept}</p>

        {due.status === "paid" && <><p className="done">Pago recibido</p><p className="muted">Gracias. Ya puedes cerrar esta página.</p></>}
        {due.status === "cancelled" && <p className="notice">El negocio canceló este cobro. No hagas ningún pago.</p>}

        {due.status === "open" && live?.kind === "qr" && (
          qrImage
            ? <><img src={qrImage} alt="Código QR de CoDi para pagar" />
                <p className="muted">Escanéalo desde la app de tu banco, en la opción CoDi. Vence en {countdown}.</p></>
            : <p className="muted">Preparando tu código QR…</p>
        )}
        {due.status === "open" && live?.kind === "push" && (
          <><p className="done">Revisa tu celular</p>
            <p className="muted">Enviamos el cobro a la app de tu banco. Ábrela y autorízalo. Vence en {countdown}.</p></>
        )}
        {due.status === "open" && !live && (
          <div className="stack">
            {due.can_push && (
              <button className="block" disabled={busy} onClick={() => start("push")}>
                Enviar a la app de mi banco{due.phone_hint ? ` (celular ••${due.phone_hint})` : ""}
              </button>
            )}
            <button className={`block${due.can_push ? " secondary" : ""}`} disabled={busy} onClick={() => start("qr")}>
              Mostrar código QR
            </button>
          </div>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </section>
      <p className="muted">Pago con CoDi®. El dinero va directo a la cuenta del negocio.</p>
    </main>
  );
}
