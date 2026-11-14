"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { clientApi } from "@/lib/client-api";
import { formatCents, parsePesosToCents } from "@/lib/phone";

type Customer = { id: string; name: string; phone: string | null; preferred_channel: string };
type Due = {
  id: string; concept: string; amount_cents: number; status: "open" | "paid" | "review" | "cancelled";
  public_token: string; created_at: string; customers: { id: string; name: string; phone: string | null } | null;
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

  const refresh = useCallback(async () => {
    const [c, d] = await Promise.all([clientApi("/api/customers"), clientApi("/api/dues")]);
    setCustomers(c.customers);
    setDues(d.dues);
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
  async function logout() {
    await clientApi("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => {});
    window.location.assign("/login");
  }

  return (
    <main>
      <div className="topbar">
        <span className="brand">Puntualito<span>.</span> <span className="muted">{merchantName}</span></span>
        <button className="quiet" onClick={logout}>Salir</button>
      </div>

      <div className="stats">
        <div className="stat"><span className="muted">Cobrado</span><strong>{formatCents(sum(paid))}</strong><span className="muted">{paid.length} pagos</span></div>
        <div className="stat"><span className="muted">Pendiente</span><strong>{formatCents(sum(open))}</strong><span className="muted">{open.length} cobros</span></div>
      </div>

      <NewDue customers={customers} onCreated={refresh} />

      <section className="card">
        <h2>Cobros</h2>
        {error && <p className="error" role="alert">{error}</p>}
        {dues.length === 0 ? <p className="muted">Aún no hay cobros. Crea el primero arriba.</p> : (
          <ul className="list">
            {dues.map(due => (
              <li key={due.id}>
                <div className="due-head">
                  <span>{due.customers?.name ?? "Sin cliente"} · {due.concept}</span>
                  <strong>{formatCents(due.amount_cents)}</strong>
                </div>
                <span className={`pill ${due.status}`}>{STATUS_LABEL[due.status]}</span>
                {due.status === "open" && (
                  <div className="actions">
                    <a className="button" href={`/pagar/${due.public_token}`} target="_blank" rel="noreferrer">Mostrar QR</a>
                    {due.customers?.phone && (
                      <a className="button secondary" href={whatsappUrl(due)} target="_blank" rel="noreferrer">Enviar por WhatsApp</a>
                    )}
                    <button className="secondary" onClick={() => copyLink(due)}>{copied === due.id ? "Link copiado" : "Copiar link"}</button>
                    <button className="quiet" onClick={() => cancel(due)}>Cancelar</button>
                  </div>
                )}
                {due.status === "review" && (
                  <p className="notice">Llegó un pago que no coincide (monto distinto o pago repetido). Revísalo en Pey.</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Customers customers={customers} onCreated={refresh} />
    </main>
  );
}

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

function NewDue({ customers, onCreated }: { customers: Customer[]; onCreated: () => Promise<void> }) {
  const [customerId, setCustomerId] = useState("");
  const [concept, setConcept] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const cents = parsePesosToCents(amount);
    if (!cents) { setError("Escribe un monto válido, por ejemplo 350 o 350.50."); return; }
    setBusy(true); setError("");
    try {
      await clientApi("/api/dues", {
        method: "POST",
        body: JSON.stringify({ customer_id: customerId || null, concept: concept.trim(), amount_cents: cents }),
      });
      setConcept(""); setAmount("");
      await onCreated();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo crear el cobro."); }
    finally { setBusy(false); }
  }
  return (
    <form className="card" onSubmit={submit}>
      <h2>Nuevo cobro</h2>
      <div className="field">
        <label htmlFor="due-customer">Cliente</label>
        <select id="due-customer" value={customerId} onChange={e => setCustomerId(e.target.value)}>
          <option value="">Sin cliente (cobro en mostrador)</option>
          {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor="due-concept">Concepto</label>
          <input id="due-concept" required maxLength={100} placeholder="Mensualidad noviembre"
            value={concept} onChange={e => setConcept(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="due-amount">Monto (MXN)</label>
          <input id="due-amount" required inputMode="decimal" placeholder="0.01"
            value={amount} onChange={e => setAmount(e.target.value)} />
        </div>
      </div>
      <button type="submit" disabled={busy}>Crear cobro</button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

function Customers({ customers, onCreated }: { customers: Customer[]; onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [optIn, setOptIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await clientApi("/api/customers", {
        method: "POST", body: JSON.stringify({ name: name.trim(), phone, whatsapp_opt_in: optIn }),
      });
      setName(""); setPhone(""); setOptIn(false);
      await onCreated();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo guardar."); }
    finally { setBusy(false); }
  }
  return (
    <section className="card">
      <h2>Clientes</h2>
      <form onSubmit={submit}>
        <div className="row">
          <div className="field">
            <label htmlFor="customer-name">Nombre</label>
            <input id="customer-name" required maxLength={100} value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="customer-phone">Celular (10 dígitos)</label>
            <input id="customer-phone" inputMode="tel" maxLength={30} value={phone} onChange={e => setPhone(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label className="check">
            <input type="checkbox" checked={optIn} onChange={e => setOptIn(e.target.checked)} />
            Aceptó recibir cobros por WhatsApp
          </label>
        </div>
        <button type="submit" className="secondary" disabled={busy}>Agregar cliente</button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
      {customers.length > 0 && (
        <ul className="list" style={{ marginTop: 16 }}>
          {customers.map(c => (
            <li key={c.id}>
              {c.name} <span className="muted">{c.phone ?? "sin celular"}
                {c.preferred_channel !== "unknown" && ` · paga por ${c.preferred_channel === "push" ? "notificación" : "QR"}`}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
