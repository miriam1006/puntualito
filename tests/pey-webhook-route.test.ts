import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { POST } from "../src/app/api/webhooks/pey/route";

const key = Buffer.from("test-only-webhook-signing-key-32-bytes");
const SECRET = `whsec_${key.toString("base64")}`;
const API_KEY_ID = "01M3QMMR6X9CBVDY1SF3G8QBJW";

const qrEvent = (apiKeyId = API_KEY_ID) => ({
  amount: 0.01, apiKeyId, codiQrId: "35a13c183a", concept: "Prueba", datePaid: 1790724818,
  numRef: "1", transactionId: "01HXYZTXN1234567890RSTUVWX", type: "codi.qr.payment_received",
});

function signed(payload: unknown, signingKey = key) {
  const body = JSON.stringify(payload);
  const id = `wh-${Math.random().toString(36).slice(2)}`;
  const time = String(Math.floor(Date.now() / 1000));
  return new Request("http://localhost/api/webhooks/pey", {
    method: "POST", body,
    headers: {
      "content-type": "application/json", "webhook-id": id, "webhook-timestamp": time,
      "webhook-signature": `v1,${createHmac("sha256", signingKey).update(`${id}.${time}.${body}`).digest("base64")}`,
    },
  });
}

/** Supabase falso: registra cada RPC y responde lo que diga `replies`. */
async function fakeSupabase(replies: Record<string, unknown>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const fn = req.url?.match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1] ?? "unknown";
      calls.push({ fn, args: body ? JSON.parse(body) : {} });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(replies[fn] ?? null));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.SUPABASE_SECRET_KEY = "test-only";
  return { calls, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

function captureWarnings() {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => { lines.push(args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")); };
  return { lines, restore: () => { console.warn = original; } };
}

test("sin PEY_API_KEY_ID: registra el apiKeyId, guarda el evento y no lo procesa como pagado", async () => {
  process.env.PEY_WEBHOOK_SECRET = SECRET;
  delete process.env.PEY_API_KEY_ID;
  const db = await fakeSupabase({ hold_pey_payment: { outcome: "held", binding: "bound", retry: true } });
  const warnings = captureWarnings();
  try {
    const res = await POST(signed(qrEvent()));
    assert.equal(res.status, 503);
    assert.deepEqual(db.calls.map(c => c.fn), ["hold_pey_payment"]);
    assert.equal(db.calls[0].args.p_pey_api_key_id, API_KEY_ID);
    assert.equal(db.calls[0].args.p_pey_ref, "35a13c183a");
    assert.ok(warnings.lines.some(l => l.includes(`PEY_API_KEY_ID no configurado; apiKeyId recibido: ${API_KEY_ID}`)));
  } finally { warnings.restore(); await db.close(); }
});

test("sin PEY_API_KEY_ID la firma sigue siendo obligatoria", async () => {
  process.env.PEY_WEBHOOK_SECRET = SECRET;
  delete process.env.PEY_API_KEY_ID;
  const db = await fakeSupabase({});
  const warnings = captureWarnings();
  try {
    const res = await POST(signed(qrEvent(), Buffer.from("otra-llave-de-firma-de-32-bytes!!")));
    assert.equal(res.status, 401);
    assert.equal(db.calls.length, 0);
    assert.ok(!warnings.lines.some(l => l.includes("apiKeyId recibido")));
  } finally { warnings.restore(); await db.close(); }
});

test("sin PEY_WEBHOOK_SECRET el webhook no acepta nada", async () => {
  delete process.env.PEY_WEBHOOK_SECRET;
  process.env.PEY_API_KEY_ID = API_KEY_ID;
  const db = await fakeSupabase({});
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await POST(signed(qrEvent()))).status, 503);
    assert.equal(db.calls.length, 0);
  } finally { console.error = original; await db.close(); }
});

test("con PEY_API_KEY_ID: un apiKeyId distinto se rechaza y el correcto se procesa", async () => {
  process.env.PEY_WEBHOOK_SECRET = SECRET;
  process.env.PEY_API_KEY_ID = API_KEY_ID;
  const db = await fakeSupabase({ process_pey_payment: { outcome: "unmatched", retry: true } });
  const warnings = captureWarnings();
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await POST(signed(qrEvent("01OTRAKEY0000000000000000")))).status, 401);
    assert.equal(db.calls.length, 0);
    assert.equal((await POST(signed(qrEvent()))).status, 503);
    assert.deepEqual(db.calls.map(c => c.fn), ["process_pey_payment"]);
    assert.equal(db.calls[0].args.p_pey_api_key_id, API_KEY_ID);
    assert.equal(db.calls[0].args.p_amount_cents, 1);
  } finally { console.error = original; warnings.restore(); await db.close(); }
});
