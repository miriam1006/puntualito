import assert from "node:assert/strict";
import test from "node:test";
import { closedStatus, excessCents, reviewReasons } from "../src/lib/review";

test("pago repetido sobre un adeudo pagado: sobra un pago y cerrar lo deja pagado", () => {
  const due = { amount_cents: 100, cancelled_at: null, paid_at: "2026-11-14T00:00:00Z" };
  const receipt = { amount_cents: 100, needs_review: false };
  assert.deepEqual(reviewReasons(due, [receipt, { ...receipt, needs_review: true }]), ["duplicate"]);
  assert.equal(excessCents(due, [receipt, receipt]), 100);
  assert.equal(closedStatus(due), "paid");
});

test("monto menor: no sobra dinero y cerrar lo cancela", () => {
  const due = { amount_cents: 60000, cancelled_at: null, paid_at: null };
  const receipts = [{ amount_cents: 100, needs_review: true }];
  assert.deepEqual(reviewReasons(due, receipts), ["amount_mismatch"]);
  assert.equal(excessCents(due, receipts), 0);
  assert.equal(closedStatus(due), "cancelled");
  assert.deepEqual(reviewReasons(due, []), ["unknown"]);
});

test("pagado después de cancelar: todo lo recibido sobra", () => {
  const due = { amount_cents: 100, cancelled_at: "2026-11-14T00:00:00Z", paid_at: null };
  const receipts = [{ amount_cents: 150, needs_review: true }];
  assert.deepEqual(reviewReasons(due, receipts), ["after_cancel", "amount_mismatch"]);
  assert.equal(excessCents(due, receipts), 150);
});
