import { pesosToCents, type PeyTransaction } from "./payment-validation";

export type ReconcileAttempt = { id: string; kind: "qr" | "push"; pey_ref: string };

/** Argumentos de process_pey_payment, el mismo camino SQL que usa el webhook. */
export type ReconciledPayment = {
  webhookId: string; payload: Record<string, unknown>; kind: "qr" | "push"; peyRef: string;
  transactionId: string; amountCents: number; paidAt: string;
};

export type ReconcileDeps = {
  getTransaction: (id: string) => Promise<PeyTransaction | null>;
  getQrTransactions: (codiQrId: string) => Promise<PeyTransaction[] | null>;
  recordPayment: (payment: ReconciledPayment) => Promise<{ outcome: string; retry: boolean }>;
};

export class ReconcileError extends Error {
  constructor(public readonly code: "unexpected_transaction" | "record_failed") {
    super("No se pudo conciliar el pago.");
    this.name = "ReconcileError";
  }
}

const PAYABLE_TYPE = { qr: "API_CODI_QR", push: "API_CODI_PN" } as const;
const EVENT_TYPE = { qr: "codi.qr.payment_received", push: "codi.pn.payment_received" } as const;

/** El webhook_id y el payload dependen solo de la transacción, así que repetir la consulta
 * cae en el `duplicate` de process_pey_payment, y si el webhook real llega antes o después,
 * el recibo por transaction_id lo vuelve `duplicate_transaction`. */
export function toReconciledPayment(attempt: ReconcileAttempt, tx: PeyTransaction): ReconciledPayment | null {
  if (tx.status !== "PAID") return null;
  if (!tx.datePaid || (tx.paymentMethod && tx.paymentMethod !== "CODI")
    || (tx.payableType && tx.payableType !== PAYABLE_TYPE[attempt.kind])
    || (attempt.kind === "push" && tx.id !== attempt.pey_ref)) {
    throw new ReconcileError("unexpected_transaction");
  }
  return {
    webhookId: `reconcile:${tx.id}`,
    payload: {
      source: "pey_reconcile", type: EVENT_TYPE[attempt.kind], transactionId: tx.id,
      amount: tx.amount, datePaid: tx.datePaid,
      ...(attempt.kind === "qr" ? { codiQrId: attempt.pey_ref } : {}),
    },
    kind: attempt.kind,
    peyRef: attempt.pey_ref,
    transactionId: tx.id,
    amountCents: pesosToCents(tx.amount),
    paidAt: new Date(tx.datePaid * 1000).toISOString(),
  };
}

/** Consulta en Pey cada intento con referencia y registra los pagos que Pey ya marca como PAID. */
export async function reconcileAttempts(attempts: ReconcileAttempt[], deps: ReconcileDeps) {
  const outcomes: string[] = [];
  for (const attempt of attempts) {
    const transactions = attempt.kind === "push"
      ? [await deps.getTransaction(attempt.pey_ref)].filter((tx): tx is PeyTransaction => tx !== null)
      : (await deps.getQrTransactions(attempt.pey_ref)) ?? [];
    for (const tx of transactions) {
      const payment = toReconciledPayment(attempt, tx);
      if (!payment) continue;
      const result = await deps.recordPayment(payment);
      if (result.retry) throw new ReconcileError("record_failed");
      outcomes.push(result.outcome);
    }
  }
  return { checked: attempts.length, outcomes };
}
