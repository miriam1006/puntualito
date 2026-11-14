export type PlanPeriod = "weekly" | "monthly";

export const WEEKDAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"] as const;

/** Fecha de hoy (YYYY-MM-DD) en la Ciudad de México, igual que el default de dues.due_date. */
export function mexicoToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/** Valida el día del plan: 1 (lunes) a 7 (domingo) si es semanal, 1 a 31 si es mensual. */
export function isValidPlanDay(period: PlanPeriod, day: number): boolean {
  if (!Number.isInteger(day)) return false;
  return period === "weekly" ? day >= 1 && day <= 7 : day >= 1 && day <= 31;
}

function parseIsoDate(iso: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error("invalid_date");
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) throw new Error("invalid_date");
  return date;
}

const toIso = (date: Date) => date.toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  const date = parseIsoDate(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return toIso(date);
}
const daysInMonth = (year: number, month0: number) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

/** Primera fecha >= from que cae en el día del plan. Un día 31 en un mes corto se recorre al último día.
 * Debe coincidir con public.plan_next_date en SQL. */
export function nextDueDate(period: PlanPeriod, day: number, from: string): string {
  if (!isValidPlanDay(period, day)) throw new Error("invalid_plan_day");
  const start = parseIsoDate(from);
  switch (period) {
    case "weekly": {
      const isoDow = ((start.getUTCDay() + 6) % 7) + 1;
      start.setUTCDate(start.getUTCDate() + ((day - isoDow + 7) % 7));
      return toIso(start);
    }
    case "monthly": {
      let year = start.getUTCFullYear();
      let month0 = start.getUTCMonth();
      let candidate = new Date(Date.UTC(year, month0, Math.min(day, daysInMonth(year, month0))));
      if (candidate < start) {
        month0 += 1;
        if (month0 === 12) { month0 = 0; year += 1; }
        candidate = new Date(Date.UTC(year, month0, Math.min(day, daysInMonth(year, month0))));
      }
      return toIso(candidate);
    }
    default: {
      const unreachable: never = period;
      throw new Error(`unknown_period_${unreachable}`);
    }
  }
}

export function describePlan(period: PlanPeriod, day: number): string {
  switch (period) {
    case "weekly": return `Cada ${WEEKDAYS[day - 1] ?? "semana"}`;
    case "monthly": return day >= 29 ? `Cada mes, día ${day} (o el último del mes)` : `Cada mes, día ${day}`;
    default: {
      const unreachable: never = period;
      return unreachable;
    }
  }
}

export function formatIsoDate(iso: string): string {
  return new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })
    .format(parseIsoDate(iso));
}
