import type { PlanPeriod } from "@/lib/plans";

export type Customer = {
  id: string; name: string; phone: string | null; whatsapp_opt_in: boolean; preferred_channel: string;
};

export type Plan = {
  id: string; concept: string; amount_cents: number; period: PlanPeriod; day_of_period: number;
  next_due_date: string; active: boolean; customers: { id: string; name: string } | null;
};

export type Session = { email: string; merchant: { id: string; name: string; max_amount_cents?: number } | null };
