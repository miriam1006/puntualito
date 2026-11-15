"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { clientApi } from "@/lib/client-api";
import { formatCents, parsePesosToCents } from "@/lib/phone";
import { addDays, describePlan, formatIsoDate, mexicoToday, nextDueDate, WEEKDAYS, type PlanPeriod } from "@/lib/plans";
import { AppHeader } from "./AppHeader";
import { GenerateDuesButton } from "./GenerateDuesButton";
import { useMerchantSession } from "./useMerchantSession";
import type { Customer, Plan } from "./types";

export function CustomersScreen() {
  const { session, error: sessionError } = useMerchantSession();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [c, p] = await Promise.all([clientApi("/api/customers"), clientApi("/api/plans")]);
    setCustomers(c.customers);
    setPlans(p.plans);
  }, []);
  useEffect(() => {
    if (session) refresh().catch(e => setError(e instanceof Error ? e.message : "No se pudo cargar."));
  }, [session, refresh]);

  if (sessionError) return <main className="narrow"><p className="error" role="alert">{sessionError}</p></main>;
  if (!session?.merchant) return <main className="narrow"><p className="muted">Cargando…</p></main>;

  return (
    <main className="app">
      <AppHeader merchantName={session.merchant.name} active="customers" />
      <section className="intro">
        <h1>Clientes y planes</h1>
        <p className="muted">Programa cobros recurrentes por cliente. Cada día Puntualito crea los que tocan.</p>
        {/* Solo tiene sentido con planes activos; para la demo corre lo que el cron hace cada mañana. */}
        {plans.length > 0 && <GenerateDuesButton className="" onGenerated={refresh} />}
      </section>
      <NewCustomer onCreated={refresh} />
      {error && <p className="error" role="alert">{error}</p>}
      {customers === null ? <p className="muted">Cargando…</p> : customers.length === 0 ? (
        <section className="card empty">
          <p className="empty-title">Aún no hay clientes</p>
          <p className="muted">Agrega el primero con el formulario de arriba.</p>
        </section>
      ) : customers.map(customer => (
        <CustomerCard key={customer.id} customer={customer}
          plans={plans.filter(p => p.customers?.id === customer.id)} onChanged={refresh} />
      ))}
    </main>
  );
}

function CustomerCard({ customer, plans, onChanged }: { customer: Customer; plans: Plan[]; onChanged: () => Promise<void> }) {
  const [mode, setMode] = useState<"view" | "edit" | "plan">("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); await onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "No se pudo completar."); }
    finally { setBusy(false); }
  }
  function deactivate() {
    const extra = plans.length ? ` Se detendrán sus ${plans.length} cobros programados.` : "";
    if (!window.confirm(`¿Dar de baja a ${customer.name}?${extra} Sus cobros pendientes siguen activos.`)) return;
    void run(() => clientApi(`/api/customers/${customer.id}/deactivate`, { method: "POST", body: "{}" }));
  }
  function stopPlan(plan: Plan) {
    if (!window.confirm(`¿Detener "${plan.concept}"? Ya no se crearán más cobros.`)) return;
    void run(() => clientApi(`/api/plans/${plan.id}/deactivate`, { method: "POST", body: "{}" }));
  }

  return (
    <article className="card customer">
      {mode === "edit" ? (
        <EditCustomer customer={customer} onDone={async saved => { setMode("view"); if (saved) await onChanged(); }} />
      ) : (
        <div className="customer-head">
          <div>
            <strong>{customer.name}</strong>
            <span className="muted"> · {customer.phone ?? "sin celular"}{customer.whatsapp_opt_in ? " · WhatsApp" : ""}
              {customer.preferred_channel !== "unknown" && ` · paga por ${customer.preferred_channel === "push" ? "notificación" : "QR"}`}</span>
          </div>
          <div className="actions">
            <button className="secondary" disabled={busy} onClick={() => setMode(mode === "plan" ? "view" : "plan")}>Programar cobro</button>
            <button className="quiet" disabled={busy} onClick={() => setMode("edit")}>Editar</button>
            <button className="quiet danger" disabled={busy} onClick={deactivate}>Dar de baja</button>
          </div>
        </div>
      )}
      {plans.length > 0 && (
        <ul className="list compact plans">
          {plans.map(plan => (
            <li key={plan.id} className="due-head">
              <span>{plan.concept} · <strong>{formatCents(plan.amount_cents)}</strong>
                <span className="muted"> · {describePlan(plan.period, plan.day_of_period)} · próximo {formatIsoDate(plan.next_due_date)}</span></span>
              <button className="quiet" disabled={busy} onClick={() => stopPlan(plan)}>Detener</button>
            </li>
          ))}
        </ul>
      )}
      {mode === "plan" && <NewPlan customer={customer} onCreated={async () => { setMode("view"); await onChanged(); }} />}
      {error && <p className="error" role="alert">{error}</p>}
    </article>
  );
}

function EditCustomer({ customer, onDone }: { customer: Customer; onDone: (saved: boolean) => Promise<void> }) {
  const [name, setName] = useState(customer.name);
  const [phone, setPhone] = useState(customer.phone ?? "");
  const [optIn, setOptIn] = useState(customer.whatsapp_opt_in);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await clientApi(`/api/customers/${customer.id}`, {
        method: "PATCH", body: JSON.stringify({ name: name.trim(), phone, whatsapp_opt_in: optIn }),
      });
      await onDone(true);
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo guardar."); setBusy(false); }
  }
  return (
    <form onSubmit={submit}>
      <div className="row">
        <div className="field">
          <label htmlFor={`name-${customer.id}`}>Nombre</label>
          <input id={`name-${customer.id}`} required maxLength={100} value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`phone-${customer.id}`}>Celular (10 dígitos)</label>
          <input id={`phone-${customer.id}`} inputMode="tel" maxLength={30} value={phone} onChange={e => setPhone(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label className="check">
          <input type="checkbox" checked={optIn} onChange={e => setOptIn(e.target.checked)} />
          Aceptó recibir cobros por WhatsApp
        </label>
      </div>
      <div className="actions">
        <button type="submit" disabled={busy}>Guardar</button>
        <button type="button" className="quiet" disabled={busy} onClick={() => onDone(false)}>Cancelar</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

function NewPlan({ customer, onCreated }: { customer: Customer; onCreated: () => Promise<void> }) {
  const [concept, setConcept] = useState("Mensualidad");
  const [amount, setAmount] = useState("");
  const [period, setPeriod] = useState<PlanPeriod>("monthly");
  const [day, setDay] = useState(1);
  const [startToday, setStartToday] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const today = mexicoToday();
  const firstDate = startToday ? today : nextDueDate(period, day, today);
  const secondDate = nextDueDate(period, day, addDays(firstDate, 1));

  function changePeriod(next: PlanPeriod) {
    setPeriod(next);
    if (next === "weekly" && day > 7) setDay(1);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const cents = parsePesosToCents(amount);
    if (!cents) { setError("Escribe un monto válido, por ejemplo 350 o 350.50."); return; }
    setBusy(true); setError("");
    try {
      await clientApi("/api/plans", {
        method: "POST",
        body: JSON.stringify({ customer_id: customer.id, concept: concept.trim(), amount_cents: cents, period, day, start_today: startToday }),
      });
      await onCreated();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo programar."); setBusy(false); }
  }
  return (
    <form className="plan-form" onSubmit={submit}>
      <h3>Nuevo cobro programado para {customer.name}</h3>
      <div className="row">
        <div className="field">
          <label htmlFor={`plan-concept-${customer.id}`}>Concepto</label>
          <input id={`plan-concept-${customer.id}`} required maxLength={100} value={concept} onChange={e => setConcept(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`plan-amount-${customer.id}`}>Monto (MXN)</label>
          <input id={`plan-amount-${customer.id}`} required inputMode="decimal" placeholder="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
        </div>
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor={`plan-period-${customer.id}`}>Frecuencia</label>
          <select id={`plan-period-${customer.id}`} value={period} onChange={e => changePeriod(e.target.value as PlanPeriod)}>
            <option value="monthly">Mensual</option>
            <option value="weekly">Semanal</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`plan-day-${customer.id}`}>{period === "weekly" ? "Día de la semana" : "Día del mes"}</label>
          <select id={`plan-day-${customer.id}`} value={day} onChange={e => setDay(Number(e.target.value))}>
            {period === "weekly"
              ? WEEKDAYS.map((name, i) => <option key={name} value={i + 1}>{name}</option>)
              : Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1}>{i + 1}{i + 1 >= 29 ? " (o último)" : ""}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label className="check">
          <input type="checkbox" checked={startToday} onChange={e => setStartToday(e.target.checked)} />
          Generar el primer cobro hoy
        </label>
      </div>
      <p className="muted">Primer cobro: {formatIsoDate(firstDate)} · después: {formatIsoDate(secondDate)}</p>
      <button type="submit" disabled={busy}>Programar</button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

function NewCustomer({ onCreated }: { onCreated: () => Promise<void> }) {
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
    <form className="card" onSubmit={submit}>
      <h2>Agregar cliente</h2>
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
  );
}
