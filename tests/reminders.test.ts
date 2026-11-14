import assert from "node:assert/strict";
import test from "node:test";
import {
  onDuesGenerated, sendDueReminders, type GeneratedDue, type ReminderCandidate, type ReminderDeps,
} from "../src/lib/reminders";

const generated = (id: string): GeneratedDue => ({
  due_id: id, plan_id: "plan-1", merchant_id: "m-1", customer_id: "c-1",
  concept: "Mensualidad", amount_cents: 1, due_date: "2026-11-14", public_token: "t".repeat(64),
});
const candidate = (id: string, daysOverdue: number): ReminderCandidate => ({
  due_id: id, merchant_id: "m-1", merchant_name: "Tienda", customer_id: "c-1", customer_name: "Ana",
  phone: "5512345678", concept: "Mensualidad", amount_cents: 1, due_date: "2026-11-01", days_overdue: daysOverdue,
  public_token: "t".repeat(64), plan_id: null,
});

function fakeDeps(overrides: Partial<ReminderDeps> = {}) {
  const created: string[] = [];
  const reminded: string[] = [];
  const calls: string[] = [];
  const deps: ReminderDeps = {
    whatsappEnabled: () => true,
    notifyDueCreated: async id => { created.push(id); },
    notifyDueReminder: async id => { reminded.push(id); },
    claimDueReminderRequests: async () => { calls.push("claim"); return []; },
    listReminderCandidates: async () => { calls.push("candidates"); return []; },
    dueIdsToSkip: async () => new Set(),
    ...overrides,
  };
  return { deps, created, reminded, calls };
}

test("onDuesGenerated manda la plantilla de cobro nuevo por cada adeudo generado", async () => {
  const { deps, created } = fakeDeps();
  await onDuesGenerated([generated("d1"), generated("d2")], deps);
  assert.deepEqual(created, ["d1", "d2"]);
});

test("onDuesGenerated sin WhatsApp configurado solo registra en logs", async () => {
  const { deps, created } = fakeDeps({ whatsappEnabled: () => false });
  await onDuesGenerated([generated("d1")], deps);
  assert.deepEqual(created, []);
});

test("onDuesGenerated no lanza si falla un envío y sigue con los demás", async () => {
  const sent: string[] = [];
  const { deps } = fakeDeps({
    notifyDueCreated: async id => { if (id === "d1") throw new Error("boom"); sent.push(id); },
  });
  await onDuesGenerated([generated("d1"), generated("d2")], deps);
  assert.deepEqual(sent, ["d2"]);
});

test("sendDueReminders sin WhatsApp no toca la base ni envía", async () => {
  const { deps, reminded, calls } = fakeDeps({ whatsappEnabled: () => false });
  const result = await sendDueReminders({}, deps);
  assert.deepEqual(result, { requests: 0, overdue: 0, skipped: true });
  assert.deepEqual(calls, []);
  assert.deepEqual(reminded, []);
});

test("sendDueReminders atiende los 'Más tarde' vencidos una sola vez por adeudo", async () => {
  const { deps, reminded } = fakeDeps({ claimDueReminderRequests: async () => ["d1", "d1", "d2"] });
  const result = await sendDueReminders({ now: new Date("2026-11-15T13:00:00Z") }, deps);
  assert.deepEqual(reminded, ["d1", "d2"]);
  assert.equal(result.requests, 2);
});

test("sendDueReminders recuerda vencidos solo en los días 1, 3 y 7 y respeta los omitidos", async () => {
  let skipArgs: string[] = [];
  const { deps, reminded } = fakeDeps({
    claimDueReminderRequests: async () => ["d-later"],
    listReminderCandidates: async () => [
      candidate("d0", 0), candidate("d1", 1), candidate("d2", 2), candidate("d3", 3),
      candidate("d7", 7), candidate("d-later", 1),
    ],
    dueIdsToSkip: async ids => { skipArgs = ids; return new Set(["d3"]); },
  });
  const result = await sendDueReminders({ now: new Date("2026-11-15T13:00:00Z"), today: "2026-11-15" }, deps);
  assert.deepEqual(skipArgs, ["d1", "d3", "d7"]);
  assert.deepEqual(reminded, ["d-later", "d1", "d7"]);
  assert.deepEqual(result, { requests: 1, overdue: 2, skipped: false });
});
