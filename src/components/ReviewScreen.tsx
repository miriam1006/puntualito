"use client";
import { useCallback, useEffect, useState } from "react";
import { clientApi } from "@/lib/client-api";
import { formatCents } from "@/lib/phone";
import { closedStatus, excessCents, reasonLabel, reviewReasons, type Resolution } from "@/lib/review";
import { AppHeader } from "./AppHeader";
import { useMerchantSession } from "./useMerchantSession";

type Receipt = {
  transaction_id: string; amount_cents: number; paid_at: string; needs_review: boolean;
  attempts: { kind: "qr" | "push"; late_payment: boolean } | null;
};
type ReviewDue = {
  id: string; concept: string; amount_cents: number; due_date: string; paid_at: string | null;
  cancelled_at: string | null; created_at: string; review_resolution: Resolution | null; review_note: string | null;
  customers: { id: string; name: string; phone: string | null } | null; payment_receipts: Receipt[];
};

const formatDateTime = (iso: string) => new Intl.DateTimeFormat("es-MX", {
  timeZone: "America/Mexico_City", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
}).format(new Date(iso));

export function ReviewScreen() {
  const { session, error: sessionError } = useMerchantSession();
  const [dues, setDues] = useState<ReviewDue[] | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const data = await clientApi("/api/review");
    setDues(data.dues);
  }, []);
  useEffect(() => {
    if (session) refresh().catch(e => setError(e instanceof Error ? e.message : "No se pudo cargar."));
  }, [session, refresh]);

  if (sessionError) return <main className="narrow"><p className="error" role="alert">{sessionError}</p></main>;
  if (!session?.merchant) return <main className="narrow"><p className="muted">Cargando…</p></main>;

  return (
    <main className="app">
      <AppHeader merchantName={session.merchant.name} active="review" reviewCount={dues?.length} />
      <section className="intro">
        <h1>Por revisar</h1>
        <p className="muted">Pagos que no cuadran: monto distinto, pago repetido o pagado después de cancelar.
          Nunca se descarta dinero recibido; aquí decides qué hacer con él.</p>
      </section>
      {error && <p className="error" role="alert">{error}</p>}
      {dues === null ? <p className="muted">Cargando…</p> : dues.length === 0 ? (
        <section className="card empty">
          <p className="empty-title">Todo en orden</p>
          <p className="muted">No hay pagos por revisar.</p>
        </section>
      ) : dues.map(due => <ReviewItem key={due.id} due={due} onResolved={refresh} />)}
    </main>
  );
}

function ReviewItem({ due, onResolved }: { due: ReviewDue; onResolved: () => Promise<void> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const receipts = due.payment_receipts ?? [];
  const received = receipts.reduce((total, r) => total + r.amount_cents, 0);
  const excess = excessCents(due, receipts);
  const closesAs = closedStatus(due);

  async function resolve(resolution: Resolution) {
    if (resolution === "refund_needed" && !note.trim()) { setError("Escribe cómo vas a devolver el dinero."); return; }
    setBusy(true); setError("");
    try {
      await clientApi(`/api/dues/${due.id}/resolve`, {
        method: "POST", body: JSON.stringify({ resolution, note: note.trim() || null }),
      });
      setNote("");
      await onResolved();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo resolver."); }
    finally { setBusy(false); }
  }

  return (
    <article className="card review-item">
      <div className="due-head">
        <span><strong>{due.customers?.name ?? "Sin cliente"}</strong> · {due.concept}</span>
        <span className="muted">Debía <strong>{formatCents(due.amount_cents)}</strong></span>
      </div>
      <div className="pills">
        {reviewReasons(due, receipts).map(reason => <span key={reason} className="pill review">{reasonLabel(reason)}</span>)}
        {due.review_resolution === "refund_needed" && <span className="pill open">Reembolso pendiente</span>}
      </div>

      <table className="receipts">
        <thead><tr><th>Pago</th><th>Monto</th><th>Canal</th><th>Fecha</th></tr></thead>
        <tbody>
          {receipts.map((r, i) => (
            <tr key={r.transaction_id} className={r.needs_review ? "flagged" : undefined}>
              <td>#{i + 1}{r.needs_review && <span className="flag"> · a revisión</span>}</td>
              <td className="num">{formatCents(r.amount_cents)}</td>
              <td>{r.attempts?.kind === "push" ? "Notificación" : "QR"}{r.attempts?.late_payment ? " · tardío" : ""}</td>
              <td>{formatDateTime(r.paid_at)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td>Recibido</td><td className="num">{formatCents(received)}</td><td colSpan={2}>
          {excess > 0 ? <span className="notice">Sobran {formatCents(excess)}</span> : received < due.amount_cents
            ? <span className="notice">Faltan {formatCents(due.amount_cents - received)}</span> : null}
        </td></tr></tfoot>
      </table>

      {due.review_note && <p className="note-saved"><span className="muted">Nota:</span> {due.review_note}</p>}

      <div className="field">
        <label htmlFor={`note-${due.id}`}>Nota (obligatoria para reembolso)</label>
        <textarea id={`note-${due.id}`} maxLength={500} rows={2} value={note} onChange={e => setNote(e.target.value)}
          placeholder="Ej. Le devolví $1 por transferencia el 14 nov." />
      </div>
      <div className="actions">
        <button disabled={busy} onClick={() => resolve("paid")}>Marcar como pagado</button>
        {due.review_resolution !== "refund_needed" && (
          <button className="secondary" disabled={busy} onClick={() => resolve("refund_needed")}>Requiere reembolso</button>
        )}
        <button className="secondary" disabled={busy} onClick={() => resolve("closed")}>
          Cerrar revisión <span className="muted">({closesAs === "paid" ? "queda pagado" : "queda cancelado"})</span>
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </article>
  );
}
