export type Resolution = "paid" | "refund_needed" | "closed";

export type ReviewReceipt = { amount_cents: number; needs_review: boolean; late_payment?: boolean };
export type ReviewDue = { amount_cents: number; cancelled_at: string | null; paid_at: string | null };

export type ReviewReason = "duplicate" | "amount_mismatch" | "after_cancel" | "unknown";

/** Por qué un adeudo quedó "Por revisar", a partir de sus recibos. El orden importa: lo más grave primero. */
export function reviewReasons(due: ReviewDue, receipts: ReviewReceipt[]): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  if (due.cancelled_at) reasons.push("after_cancel");
  if (receipts.some(r => r.amount_cents !== due.amount_cents)) reasons.push("amount_mismatch");
  if (receipts.length > 1) reasons.push("duplicate");
  return reasons.length ? reasons : ["unknown"];
}

export function reasonLabel(reason: ReviewReason): string {
  switch (reason) {
    case "duplicate": return "Pago repetido";
    case "amount_mismatch": return "Monto distinto";
    case "after_cancel": return "Pagado después de cancelar";
    case "unknown": return "Revisión manual";
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

/** Dinero recibido de más respecto a lo que se debía: lo que habría que devolver. */
export function excessCents(due: ReviewDue, receipts: ReviewReceipt[]): number {
  const received = receipts.reduce((total, r) => total + r.amount_cents, 0);
  const owed = due.cancelled_at && !due.paid_at ? 0 : due.amount_cents;
  return Math.max(0, received - owed);
}

/** Estado en que queda el adeudo al cerrarlo sin marcarlo pagado. Debe coincidir con public.resolve_due. */
export function closedStatus(due: ReviewDue): "paid" | "cancelled" {
  return due.paid_at ? "paid" : "cancelled";
}

export function resolutionLabel(resolution: Resolution): string {
  switch (resolution) {
    case "paid": return "Marcado como pagado";
    case "refund_needed": return "Reembolso pendiente";
    case "closed": return "Cerrado";
    default: {
      const unreachable: never = resolution;
      return unreachable;
    }
  }
}
