"use client";

export type WhatsAppMessage = {
  id: string; due_id: string; direction: "out" | "in";
  purpose: "due_created" | "reminder" | "qr" | "later_ack" | "payment_received" | "reply" | "button_pay_qr" | "button_later" | "inbound";
  kind: string; status: "queued" | "sent" | "delivered" | "read" | "failed" | "received";
  body: string | null; error_code: string | null; error_title: string | null; status_at: string | null; created_at: string;
};

const PURPOSE_LABEL: Record<WhatsAppMessage["purpose"], string> = {
  due_created: "Cobro enviado",
  reminder: "Recordatorio",
  qr: "QR enviado",
  later_ack: "Confirmación de recordatorio",
  payment_received: "Pago recibido",
  reply: "Respuesta",
  button_pay_qr: "Cliente: Prefiero QR",
  button_later: "Cliente: Más tarde",
  inbound: "Cliente escribió",
};

const STATUS_LABEL: Record<WhatsAppMessage["status"], string> = {
  queued: "En cola", sent: "Enviado", delivered: "Entregado", read: "Leído", failed: "Falló", received: "Recibido",
};

const ERROR_HINT: Record<string, string> = {
  "131030": "El número no está en la lista de prueba de Meta.",
  "131047": "Pasaron más de 24 h desde que el cliente escribió; se necesita plantilla.",
  "131026": "El número no tiene WhatsApp o no se pudo entregar.",
  "132001": "La plantilla no existe o no está aprobada en ese idioma.",
  "190": "El token de acceso de Meta venció.",
};

function failure(m: WhatsAppMessage) {
  return (m.error_code && ERROR_HINT[m.error_code]) || m.error_title || m.error_code || "";
}

export function groupByDue(messages: WhatsAppMessage[]) {
  const grouped: Record<string, WhatsAppMessage[]> = {};
  for (const m of messages) (grouped[m.due_id] ??= []).push(m);
  return grouped;
}

const STATUS_PILL: Record<WhatsAppMessage["status"], string> = {
  queued: "cancelled", sent: "open", delivered: "paid", read: "paid", failed: "review", received: "paid",
};

const time = (iso: string) => new Date(iso).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });

export function WhatsAppHistory({ messages }: { messages: WhatsAppMessage[] | undefined }) {
  if (!messages?.length) return null;
  const ordered = [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const last = ordered[ordered.length - 1];
  return (
    <details style={{ marginTop: 8, fontSize: "0.9rem" }}>
      <summary className="muted" style={{ cursor: "pointer" }}>
        WhatsApp: {PURPOSE_LABEL[last.purpose]} · {STATUS_LABEL[last.status]}
        {last.status === "failed" && failure(last) ? ` (${failure(last)})` : ""}
      </summary>
      <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "grid", gap: 4 }}>
        {ordered.map(m => (
          <li key={m.id} style={{ padding: 0, borderTop: 0 }}>
            <span className="muted">{time(m.created_at)}</span> {m.direction === "in" ? "←" : "→"} {PURPOSE_LABEL[m.purpose]}
            {" "}<span className={`pill ${STATUS_PILL[m.status]}`}>{STATUS_LABEL[m.status]}</span>
            {m.status === "failed" && failure(m) && <span className="error"> {failure(m)}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}
