import assert from "node:assert/strict";
import test from "node:test";
import { addDays, describePlan, isValidPlanDay, mexicoToday, nextDueDate } from "../src/lib/plans";
import { cronAuthorized } from "../src/lib/cron";

test("nextDueDate coincide con public.plan_next_date (mismos casos que la prueba SQL)", () => {
  assert.equal(nextDueDate("weekly", 1, "2026-11-14"), "2026-11-16");
  assert.equal(nextDueDate("weekly", 6, "2026-11-14"), "2026-11-14");
  assert.equal(nextDueDate("weekly", 5, "2026-11-14"), "2026-11-20");
  assert.equal(nextDueDate("weekly", 7, "2026-11-14"), "2026-11-15");
  assert.equal(nextDueDate("monthly", 14, "2026-11-14"), "2026-11-14");
  assert.equal(nextDueDate("monthly", 10, "2026-11-14"), "2026-12-10");
  assert.equal(nextDueDate("monthly", 31, "2026-11-14"), "2026-11-30");
  assert.equal(nextDueDate("monthly", 5, "2026-12-20"), "2027-01-05");
  assert.equal(nextDueDate("monthly", 31, "2027-02-01"), "2027-02-28");
  assert.equal(nextDueDate("monthly", 30, "2028-02-01"), "2028-02-29");
});

test("nextDueDate rechaza días y fechas inválidos", () => {
  assert.throws(() => nextDueDate("weekly", 8, "2026-11-14"), /invalid_plan_day/);
  assert.throws(() => nextDueDate("monthly", 0, "2026-11-14"), /invalid_plan_day/);
  assert.throws(() => nextDueDate("monthly", 1, "2026-02-30"), /invalid_date/);
  assert.equal(isValidPlanDay("monthly", 31), true);
  assert.equal(isValidPlanDay("weekly", 1.5), false);
});

test("mexicoToday usa la hora de la Ciudad de México", () => {
  assert.equal(mexicoToday(new Date("2026-11-15T05:30:00Z")), "2026-11-14");
  assert.equal(mexicoToday(new Date("2026-11-15T06:30:00Z")), "2026-11-15");
});

test("addDays cruza fin de mes y de año", () => {
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("describePlan", () => {
  assert.equal(describePlan("weekly", 1), "Cada lunes");
  assert.equal(describePlan("monthly", 5), "Cada mes, día 5");
  assert.equal(describePlan("monthly", 31), "Cada mes, día 31 (o el último del mes)");
});

test("cron exige CRON_SECRET como Bearer", () => {
  assert.equal(cronAuthorized("Bearer s3cr3t-largo-de-prueba", "s3cr3t-largo-de-prueba"), true);
  assert.equal(cronAuthorized("Bearer otro", "s3cr3t-largo-de-prueba"), false);
  assert.equal(cronAuthorized(null, "s3cr3t-largo-de-prueba"), false);
  assert.equal(cronAuthorized("Bearer ", ""), false);
  assert.equal(cronAuthorized("Bearer x", undefined), false);
  assert.equal(cronAuthorized("s3cr3t-largo-de-prueba", "s3cr3t-largo-de-prueba"), false);
});
