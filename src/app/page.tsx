"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { clientApi } from "@/lib/client-api";
import { formatCents, parsePesosToCents } from "@/lib/phone";
import { AppHeader } from "@/components/AppHeader";
import { groupByDue, WhatsAppHistory, type WhatsAppMessage } from "./WhatsAppHistory";

type Customer = { id: string; name: string; phone: string | null; preferred_channel: string };
type Due = {
  id: string; concept: string; amount_cents: number; status: "open" | "paid" | "review" | "cancelled";
  public_token: string; created_at: string; customers: { id: string; name: string; phone: string | null } | null;
  can_verify?: boolean;
};
type Session = { email: string; merchant: { id: string; name: string } | null };

const STATUS_LABEL: Record<Due["status"], string> = {
  open: "Pendiente", paid: "Pagado", review: "Por revisar", cancelled: "Cancelado",
};

export default function Dashboard() {
  const [session, setSession] = useState<Session | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [dues, setDues] = useState<Due[]>([]);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [verifying, setVerifying] = useState("");
  const [pushing, setPushing] = useState("");
  const [verifyResult, setVerifyResult] = useState<{ dueId: string; text: string } | null>(null);
  const [messagesByDue, setMessagesByDue] = useState<Record<string, WhatsAppMessage[]>>({});

  const refresh = useCallback(async () => {
    const [c, d] = await Promise.all([clientApi("/api/customers"), clientApi("/api/dues")]);
    setCustomers(c.customers);
    setDues(d.dues);
    // Sin la migración de WhatsApp el panel sigue funcionando, solo sin historial.
    clientApi("/api/whatsapp/messages")
      .then(({ messages }: { messages: WhatsAppMessage[] }) => setMessagesByDue(groupByDue(messages)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    clientApi("/api/session")
      .then(async (s: Session) => { setSession(s); if (s.merchant) await refresh(); })
      .catch(e => setError(e instanceof Error ? e.message : "No se pudo cargar."));
  }, [refresh]);

  // Los pagos llegan por webhook: se consulta cada 10 s mientras la pestaña está abierta.
  useEffect(() => {
    if (!session?.merchant) return;
    const timer = setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 10_000);
    return () => clearInterval(timer);
  }, [session, refresh]);

  if (error && !session) return <main className="narrow"><p className="error" role="alert">{error}</p></main>;
  if (!session) return <main className="narrow"><p className="muted">Cargando…</p></main>;
  if (!session.merchant) return <CreateMerchant onCreated={merchant => setSession({ ...session, merchant })} />;

  const paid = dues.filter(d => d.status === "paid");
  const open = dues.filter(d => d.status === "open");
  const review = dues.filter(d => d.status === "review");
  const sum = (list: Due[]) => list.reduce((total, d) => total + d.amount_cents, 0);
  const linkFor = (due: Due) => `${window.location.origin}/pagar/${due.public_token}`;
  const merchantName = session.merchant.name;

  async function copyLink(due: Due) {
    await navigator.clipboard.writeText(linkFor(due));
    setCopied(due.id);
    setTimeout(() => setCopied(""), 2000);
  }
  function whatsappUrl(due: Due) {
    const text = `Hola ${due.customers?.name ?? ""}, te comparto tu cobro de ${merchantName}: ${due.concept} por ${formatCents(due.amount_cents)}. Puedes pagarlo con CoDi aquí: ${linkFor(due)}`;
    return `https://wa.me/52${due.customers?.phone}?text=${encodeURIComponent(text)}`;
  }
  async function cancel(due: Due) {
    setError("");
    try { await clientApi(`/api/dues/${due.id}/cancel`, { method: "POST", body: "{}" }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "No se pudo cancelar."); }
  }
  async function pushNow(due: Due) {
    setError(""); setVerifyResult(null); setPushing(due.id);
    try {
      const data = await clientApi(`/api/dues/${due.id}/push`, { method: "POST", body: "{}" });
      setVerifyResult({ dueId: due.id, text: data.text });
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo mandar la notificación."); }
    finally { setPushing(""); }
  }
  async function verify(due: Due) {
    setError(""); setVerifyResult(null); setVerifying(due.id);
    try {
      const data = await clientApi(`/api/dues/${due.id}/verify`, { method: "POST", body: "{}" });
      const text = data.due_status === "paid" ? "Pago confirmado con Pey."
        : data.due_status === "review" ? "Pey reporta un pago que no coincide; quedó por revisar."
        : "Pey todavía no reporta un pago para este cobro.";
      setVerifyResult({ dueId: due.id, text });
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo verificar el pago."); }
    finally { setVerifying(""); }
  }

  return (
    <main className="app dashboard">
      <AppHeader merchantName={merchantName} active="panel" reviewCount={review.length} />
      <h1>Panel de cobranza</h1>

      <div className="stats">
        <div className="stat paid"><span className="muted">Cobrado</span><strong>{formatCents(sum(paid))}</strong><span className="muted">{plural(paid.length, "pago", "pagos")}</span></div>
        <div className="stat open"><span className="muted">Pendiente</span><strong>{formatCents(sum(open))}</strong><span className="muted">{plural(open.length, "cobro", "cobros")}</span></div>
        {review.length > 0 && (
          <a className="stat review" href="/revisar"><span className="muted">Por revisar</span><strong>{review.length}</strong><span className="muted">Resolver ahora →</span></a>
        )}
      </div>

      <div className="dashboard-columns">
        <div>
          <section className="card">
            <h2>Cobros</h2>
            {error && <p className="error" role="alert">{error}</p>}
            {dues.length === 0 ? <p className="muted">Aún no hay cobros. Crea el primero con «Nuevo cobro».</p> : (
              <ul className="list">
                {dues.map(due => (
                  <li key={due.id}>
                    <div className="due-head">
                      <span>{due.customers?.name ?? "Sin cliente"} · {due.concept}</span>
                      <strong>{formatCents(due.amount_cents)}</strong>
                    </div>
                    <span className={`pill ${due.status}`}>{STATUS_LABEL[due.status]}</span>
                    <WhatsAppHistory messages={messagesByDue[due.id]} />
                    {due.status === "open" && (
                      <div className="due-actions">
                        {due.customers?.phone && (
                          <button onClick={() => pushNow(due)} disabled={pushing === due.id}>
                            {pushing === due.id ? "Enviando…" : "Cobrar ahora"}
                          </button>
                        )}
                        <a className="button" href={`/chat/${due.public_token}`} target="_blank" rel="noreferrer">Ver chat de WhatsApp</a>
                        <a className="button" href={`/pagar/${due.public_token}`} target="_blank" rel="noreferrer">Mostrar QR</a>
                        {due.customers?.phone && (
                          <a className="button" href={whatsappUrl(due)} target="_blank" rel="noreferrer">Enviar por WhatsApp</a>
                        )}
                        <button onClick={() => copyLink(due)}>{copied === due.id ? "Link copiado" : "Copiar link"}</button>
                        {due.can_verify && (
                          <button onClick={() => verify(due)} disabled={verifying === due.id}>
                            {verifying === due.id ? "Verificando…" : "Verificar pago"}
                          </button>
                        )}
                        <button className="quiet" onClick={() => cancel(due)}>Cancelar</button>
                      </div>
                    )}
                    {verifyResult?.dueId === due.id && <p className="muted" role="status">{verifyResult.text}</p>}
                    {due.status === "review" && (
                      <p className="notice">Llegó un pago que no coincide (monto distinto o pago repetido). <a className="link" href="/revisar">Resolver</a></p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div>
          <NewDue customers={customers} onCreated={refresh} />
        </div>
      </div>
    </main>
  );
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function CreateMerchant({ onCreated }: { onCreated: (merchant: { id: string; name: string }) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const data = await clientApi("/api/merchant", { method: "POST", body: JSON.stringify({ name }) });
      onCreated(data.merchant);
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo crear."); setBusy(false); }
  }
  return (
    <main className="narrow">
      <div className="topbar"><span className="brand">Puntualito<span>.</span></span></div>
      <form className="card" onSubmit={submit}>
        <h1>Crea tu negocio</h1>
        <p className="muted">Así lo verán tus clientes cuando les llegue un cobro.</p>
        <div className="field">
          <label htmlFor="merchant-name">Nombre del negocio</label>
          <input id="merchant-name" required maxLength={100} value={name} onChange={e => setName(e.target.value)} />
        </div>
        <button className="block" type="submit" disabled={busy}>Crear</button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </main>
  );
}

const NEW_CUSTOMER = "new";

/** Alta rápida: elige un cliente o crea uno nuevo aquí mismo y, si tiene celular, manda el push
 * CoDi en el mismo paso ("Crear y cobrar ahora") sin pasar por Clientes ni por el chat. */
function NewDue({ customers, onCreated }: { customers: Customer[]; onCreated: () => Promise<void> }) {
  const [customerId, setCustomerId] = useState(NEW_CUSTOMER);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [optIn, setOptIn] = useState(true);
  const [concept, setConcept] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ text: string; token: string; ok: boolean } | null>(null);

  const isNew = customerId === NEW_CUSTOMER;
  const selected = customers.find(c => c.id === customerId);
  const canPush = isNew ? phone.replace(/\D/g, "").length >= 10 : Boolean(selected?.phone);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const pushNow = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "push";
    const cents = parsePesosToCents(amount);
    if (!cents) { setError("Escribe un monto válido, por ejemplo 350 o 350.50."); return; }
    setBusy(pushNow ? "push" : "create"); setError(""); setResult(null);
    try {
      let id: string | null = customerId || null;
      if (isNew) {
        const data = await clientApi("/api/customers", {
          method: "POST", body: JSON.stringify({ name: name.trim(), phone, whatsapp_opt_in: optIn }),
        });
        id = data.customer.id;
        // Si el cobro falla después, el cliente ya existe: queda seleccionado para no duplicarlo.
        setCustomerId(data.customer.id); setName(""); setPhone("");
      }
      const { due } = await clientApi("/api/dues", {
        method: "POST", body: JSON.stringify({ customer_id: id, concept: concept.trim(), amount_cents: cents }),
      });
      setConcept(""); setAmount("");
      if (pushNow) {
        try {
          const push = await clientApi(`/api/dues/${due.id}/push`, { method: "POST", body: "{}" });
          setResult({ text: push.text, token: due.public_token, ok: push.sent });
        } catch (e) {
          setResult({ text: `El cobro se creó, pero no se mandó la notificación: ${e instanceof Error ? e.message : "intenta de nuevo"}`, token: due.public_token, ok: false });
        }
      } else {
        setResult({ text: "Cobro creado.", token: due.public_token, ok: true });
      }
      await onCreated();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo crear el cobro."); await onCreated().catch(() => {}); }
    finally { setBusy(""); }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Nuevo cobro</h2>
      <div className="field">
        <label htmlFor="due-customer">Cliente</label>
        <select id="due-customer" value={customerId} onChange={e => { setCustomerId(e.target.value); setResult(null); }}>
          <option value={NEW_CUSTOMER}>+ Cliente nuevo</option>
          {customers.map(c => <option key={c.id} value={c.id}>{c.name}{c.phone ? "" : " (sin celular)"}</option>)}
          <option value="">Sin cliente (cobro en mostrador)</option>
        </select>
      </div>
      {isNew && (
        <div className="new-customer">
          <div className="row due-row">
            <div className="field">
              <label htmlFor="due-new-name">Nombre</label>
              <input id="due-new-name" required maxLength={100} placeholder="Ej. Ana López" autoComplete="off"
                value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="due-new-phone">Celular (10 dígitos)</label>
              <input id="due-new-phone" inputMode="tel" maxLength={30} placeholder="Ej. 55 1234 5678" autoComplete="off"
                value={phone} onChange={e => setPhone(e.target.value)} />
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={optIn} onChange={e => setOptIn(e.target.checked)} />
            Aceptó recibir cobros por WhatsApp
          </label>
        </div>
      )}
      <div className="row due-row">
        <div className="field">
          <label htmlFor="due-concept">Concepto</label>
          <input id="due-concept" required maxLength={100} placeholder="Ej. Mensualidad noviembre"
            value={concept} onChange={e => setConcept(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="due-amount">Monto (MXN)</label>
          <div className="money-input">
            <span aria-hidden="true">$</span>
            <input id="due-amount" required inputMode="decimal" placeholder="0.00"
              value={amount} onChange={e => setAmount(e.target.value)} />
          </div>
        </div>
      </div>
      <div className="form-actions">
        {canPush && (
          <button type="submit" value="push" disabled={Boolean(busy)}>
            {busy === "push" ? "Enviando…" : "Crear y cobrar ahora"}
          </button>
        )}
        <button type="submit" value="create" className={canPush ? "secondary" : undefined} disabled={Boolean(busy)}>
          {busy === "create" ? "Creando…" : canPush ? "Solo crear" : "Crear cobro"}
        </button>
      </div>
      {canPush && <p className="muted hint">«Cobrar ahora» manda la notificación CoDi a la app del banco del cliente.</p>}
      {result && (
        <p className={result.ok ? "success" : "error"} role="status">
          {result.text} <a className="link" href={`/chat/${result.token}`} target="_blank" rel="noreferrer">Ver chat</a>
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}
