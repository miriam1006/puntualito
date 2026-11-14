import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createPeyPush, getPeyQrTransactions, getPeyTransaction, PeyError } from "../src/lib/pey";

// Pey no tiene sandbox: estas pruebas reemplazan fetch y fallan si algo intenta salir a la red.
type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let reply: (call: Call) => Response;
const realFetch = globalThis.fetch;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls = [];
  reply = () => { throw new Error("respuesta de Pey sin simular"); };
  process.env.PEY_API_KEY = "test-only-not-a-real-key";
  process.env.PEY_MAX_AMOUNT_CENTS = "1";
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

test("POST /codi/pn manda los campos del spec y lee transactionId y codiId", async () => {
  reply = () => json(200, { transactionId: "01J5KXYZ1234567890ABCD", codiId: "12345678901234567890" });
  const result = await createPeyPush({ amountCents: 1, concept: "Mensualidad", numRef: "42", phone: "5512345678" });
  assert.deepEqual(result, { transactionId: "01J5KXYZ1234567890ABCD", codiId: "12345678901234567890" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.pey.mx/codi/pn");
  assert.equal(calls[0].init.method, "POST");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer test-only-not-a-real-key");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)),
    { amount: 0.01, phoneNumber: "5512345678", concept: "Mensualidad", expiration: 360, numRef: "42" });
});

test("el push respeta el tope de pruebas sin llamar a Pey", async () => {
  await assert.rejects(createPeyPush({ amountCents: 2, concept: "x", numRef: "1", phone: "5512345678" }),
    (e: unknown) => e instanceof PeyError && e.code === "over_limit");
  assert.equal(calls.length, 0);
});

test("GET /transaction/{id} devuelve la transacción sin metadata", async () => {
  reply = () => json(200, {
    id: "01HXYZTXN1234567890ABCDE00", status: "PAID", amount: 0.01, amountBreakdown: { base: 0.01, tip: 0, fee: 0 },
    currency: "MXN", paymentMethod: "CODI", payableType: "API_CODI_PN", payableId: "01HXYZ1234567890ABCDEFGH00",
    dateCreated: 1704067200, datePaid: 1704067260, metadata: { clabe: "000000000000000000" },
  });
  const tx = await getPeyTransaction("01HXYZTXN1234567890ABCDE00");
  assert.equal(calls[0].url, "https://api.pey.mx/transaction/01HXYZTXN1234567890ABCDE00");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined);
  assert.equal(tx?.status, "PAID");
  assert.equal(tx && "metadata" in tx, false);
});

test("404 de Pey es 'no existe'; 5xx y respuestas raras son errores", async () => {
  reply = () => json(404, { error: { message: "Transaction not found", type: "NOT_FOUND" } });
  assert.equal(await getPeyTransaction("01HXYZTXN1234567890ABCDE00"), null);
  assert.equal(await getPeyQrTransactions("AB12CD34EF"), null);
  reply = () => json(500, { error: { type: "INTERNAL_SERVER_ERROR" } });
  await assert.rejects(getPeyTransaction("01HX"), (e: unknown) => e instanceof PeyError && e.code === "rejected" && e.httpStatus === 500);
  reply = () => json(200, { status: "PAID" });
  await assert.rejects(getPeyTransaction("01HX"), (e: unknown) => e instanceof PeyError && e.code === "invalid_response");
});

test("GET /transaction/codi/qr/{id} lee la primera página de transacciones del QR", async () => {
  reply = () => json(200, {
    items: [
      { id: "01TXPAID", status: "PAID", amount: 0.01, paymentMethod: "CODI", dateCreated: 1704067200, datePaid: 1704067200 },
      { id: "01TXPEND", status: "PENDING", amount: 0.01, paymentMethod: "CODI", dateCreated: 1704067200 },
    ],
    nextToken: null,
  });
  const items = await getPeyQrTransactions("35a13c183a");
  assert.equal(calls[0].url, "https://api.pey.mx/transaction/codi/qr/35a13c183a");
  assert.deepEqual(items?.map(tx => tx.id), ["01TXPAID", "01TXPEND"]);
});

test("un id con caracteres raros no llega a la URL de Pey", async () => {
  await assert.rejects(getPeyTransaction("../codi/qr"));
  await assert.rejects(getPeyQrTransactions("a?b=1"));
  assert.equal(calls.length, 0);
});

test("sin PEY_API_KEY no hay llamada", async () => {
  delete process.env.PEY_API_KEY;
  await assert.rejects(getPeyTransaction("01HX"), (e: unknown) => e instanceof PeyError && e.code === "configuration");
  assert.equal(calls.length, 0);
});
