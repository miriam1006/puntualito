"use client";
import { useEffect, useState } from "react";
import { clientApi } from "@/lib/client-api";
import { formatCents } from "@/lib/phone";
import { describePlan, formatIsoDate } from "@/lib/plans";
import type { Plan } from "./types";

/** Tarjeta del panel: próximos cobros programados. Generarlos a mano vive en Clientes y planes. */
export function ScheduledSummary() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  useEffect(() => {
    clientApi("/api/plans").then(data => setPlans(data.plans)).catch(() => setPlans([]));
  }, []);

  const upcoming = (plans ?? []).slice(0, 3);
  return (
    <section className="card scheduled">
      <div className="card-head">
        <h2>Cobros programados</h2>
        <a className="link" href="/clientes">Administrar</a>
      </div>
      {plans === null ? <p className="muted">Cargando…</p> : plans.length === 0 ? (
        <p className="muted">Programa mensualidades en <a className="link" href="/clientes">Clientes y planes</a> y Puntualito crea el cobro cada periodo.</p>
      ) : (
        <ul className="list compact">
          {upcoming.map(plan => (
            <li key={plan.id} className="due-head">
              <span>{plan.customers?.name ?? "Cliente"} · {plan.concept}
                <span className="muted"> · {describePlan(plan.period, plan.day_of_period)} · próximo {formatIsoDate(plan.next_due_date)}</span></span>
              <strong>{formatCents(plan.amount_cents)}</strong>
            </li>
          ))}
          {plans.length > upcoming.length && <li className="muted">y {plans.length - upcoming.length} más</li>}
        </ul>
      )}
    </section>
  );
}
