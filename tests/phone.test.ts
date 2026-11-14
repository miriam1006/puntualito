import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMxPhone, parsePesosToCents } from "../src/lib/phone";

test("normaliza celulares mexicanos a 10 dígitos", () => {
  assert.equal(normalizeMxPhone("5512345678"), "5512345678");
  assert.equal(normalizeMxPhone("55 1234 5678"), "5512345678");
  assert.equal(normalizeMxPhone("+52 55 1234 5678"), "5512345678");
  assert.equal(normalizeMxPhone("+52 1 55 1234 5678"), "5512345678");
  for (const bad of ["", "551234567", "55123456789", "abc"]) assert.equal(normalizeMxPhone(bad), null);
});

test("convierte pesos escritos a centavos sin perder precisión", () => {
  assert.equal(parsePesosToCents("0.01"), 1);
  assert.equal(parsePesosToCents("350"), 35000);
  assert.equal(parsePesosToCents("350.5"), 35050);
  assert.equal(parsePesosToCents("$1,250.75"), 125075);
  assert.equal(parsePesosToCents("0.29"), 29);
  for (const bad of ["", "0", "0.00", "1.999", "-5", "abc", "1e3"]) assert.equal(parsePesosToCents(bad), null);
});
