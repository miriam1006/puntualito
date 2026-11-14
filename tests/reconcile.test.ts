import assert from "node:assert/strict";
import test from "node:test";
import type { PeyTransaction } from "../src/lib/payment-validation";
import { reconcileAttempts, ReconcileError, type ReconciledPayment, type ReconcileDeps } from "../src/lib/reconcile";

const push = { id: "attempt-push", kind: "push" as const, pey_ref: "01PUSHTX" };
const qr = { id: "attempt-qr", kind: "qr" as const, pey_ref: "35a13c183a" };
const paidPush: PeyTransaction = {
  id: "01PUSHTX", status: "PAID", amount: 0.01, paymentMethod: "CODI", payableType: "API_CODI_PN", datePaid: 1790724758,
};

function fakeDeps(overrides: Partial<ReconcileDeps> = {}) {
  const recorded: ReconciledPayment[] = [];
  const deps: ReconcileDeps = {
    getTransaction: async () => null,
    getQrTransactions: async () => null,
    recordPayment: async payment => { recorded.push(payment); return { outcome: "paid", retry: false }; },
    ...overrides,
  };
  return { deps, recorded };
}

test("push pagado se registra con los argumentos de process_pey_payment", async () => {
  const { deps, recorded } = fakeDeps({ getTransaction: async id => (id === "01PUSHTX" ? paidPush : null) });
  const result = await reconcileAttempts([push], deps);
  assert.deepEqual(result, { checked: 1, outcomes: ["paid"] });
  assert.deepEqual(recorded, [{
    webhookId: "reconcile:01PUSHTX",
    payload: { source: "pey_reconcile", type: "codi.pn.payment_received", transactionId: "01PUSHTX", amount: 0.01, datePaid: 1790724758 },
    kind: "push", peyRef: "01PUSHTX", transactionId: "01PUSHTX", amountCents: 1,
    paidAt: new Date(1790724758 * 1000).toISOString(),
  }]);
});

test("verificar dos veces produce exactamente el mismo webhook_id y payload", async () => {
  const { deps, recorded } = fakeDeps({ getTransaction: async () => paidPush });
  await reconcileAttempts([push], deps);
  await reconcileAttempts([push], deps);
  assert.equal(recorded.length, 2);
  assert.deepEqual(recorded[0], recorded[1]);
});

test("pendiente o inexistente en Pey no registra nada", async () => {
  const { deps, recorded } = fakeDeps({
    getTransaction: async () => ({ ...paidPush, status: "PENDING", datePaid: null }),
    getQrTransactions: async () => null,
  });
  assert.deepEqual(await reconcileAttempts([push, qr], deps), { checked: 2, outcomes: [] });
  assert.equal(recorded.length, 0);
});

test("QR: registra solo las transacciones PAID, con el codiQrId como referencia", async () => {
  const { deps, recorded } = fakeDeps({
    getQrTransactions: async () => [
      { id: "01QRPAID", status: "PAID", amount: 0.01, paymentMethod: "CODI", datePaid: 1790724818 },
      { id: "01QRPEND", status: "PENDING", amount: 0.01, paymentMethod: "CODI" },
    ],
  });
  await reconcileAttempts([qr], deps);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].webhookId, "reconcile:01QRPAID");
  assert.equal(recorded[0].peyRef, "35a13c183a");
  assert.equal(recorded[0].transactionId, "01QRPAID");
  assert.equal(recorded[0].payload.codiQrId, "35a13c183a");
  assert.equal(recorded[0].payload.type, "codi.qr.payment_received");
});

test("una transacción que no corresponde al intento se rechaza sin registrar", async () => {
  for (const tx of [
    { ...paidPush, id: "01OTRA" },
    { ...paidPush, payableType: "PAYMENT_LINK" },
    { ...paidPush, paymentMethod: "CARD" },
    { ...paidPush, datePaid: null },
  ]) {
    const { deps, recorded } = fakeDeps({ getTransaction: async () => tx });
    await assert.rejects(reconcileAttempts([push], deps), (e: unknown) => e instanceof ReconcileError && e.code === "unexpected_transaction");
    assert.equal(recorded.length, 0);
  }
});

test("si process_pey_payment pide reintento, la conciliación falla", async () => {
  const { deps } = fakeDeps({
    getTransaction: async () => paidPush,
    recordPayment: async () => ({ outcome: "unmatched", retry: true }),
  });
  await assert.rejects(reconcileAttempts([push], deps), (e: unknown) => e instanceof ReconcileError && e.code === "record_failed");
});
