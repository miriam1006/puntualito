"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { clientApi } from "@/lib/client-api";
import { formatCents } from "@/lib/phone";
import "./chat.css";

type Action = "pay_now" | "pay_later" | "pay_qr";
type Reply = { text: string; buttons: Action[]; qrString?: string };
type Message = { id: number; from: "biz" | "me"; text: string; buttons?: Action[]; qr?: string; time: string; receipt?: boolean };
type PayStatus = { status: "open" | "paid" | "cancelled"; concept: string; amount_cents: number; merchant_name: string; paid_at?: string | null };

const TITLES: Record<Action, string> = { pay_now: "Pagar ahora", pay_later: "Más tarde", pay_qr: "Enviar QR" };
const clock = new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" });
const now = () => clock.format(new Date());

/** Vista previa del chat de WhatsApp: los botones llaman al mismo flujo que el webhook de Meta
 * (push y QR de CoDi reales con Pey). Solo cambia que el mensaje se ve aquí y no en WhatsApp. */
export default function ChatClient({ token }: { token: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<PayStatus | null>(null);
  const [typing, setTyping] = useState(false);
  const [missing, setMissing] = useState(false);
  const nextId = useRef(1);
  const receiptShown = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  const add = useCallback((message: Omit<Message, "id" | "time">) => {
    setMessages(list => [...list, { ...message, id: nextId.current++, time: now() }]);
  }, []);

  const showReceipt = useCallback((due: PayStatus) => {
    if (receiptShown.current) return;
    receiptShown.current = true;
    add({ from: "biz", receipt: true,
      text: `¡Pago recibido! Tu pago de ${formatCents(due.amount_cents)} por ${due.concept} quedó registrado en ${due.merchant_name}. Guarda este mensaje para tu referencia.` });
  }, [add]);

  const loadStatus = useCallback(async () => {
    const data = await clientApi(`/api/pay/${token}`, { publicPage: true });
    setStatus(data.due);
    if (data.due.status === "paid") showReceipt(data.due);
    return data.due as PayStatus;
  }, [token, showReceipt]);

  useEffect(() => {
    Promise.all([clientApi(`/api/chat/${token}`, { publicPage: true }), loadStatus()])
      .then(([chat, due]) => {
        setMessages([{ id: nextId.current++, from: "biz", text: chat.message, time: now(),
          buttons: due.status === "open" ? ["pay_now", "pay_later"] : [] }]);
        if (due.status === "paid") { receiptShown.current = false; showReceipt(due); }
      })
      .catch(() => setMissing(true));
  }, [token, loadStatus, showReceipt]);

  // El pago lo confirma el webhook de Pey en el servidor; aquí solo se consulta el estado.
  useEffect(() => {
    if (!status || status.status !== "open") return;
    const poll = setInterval(() => { if (!document.hidden) loadStatus().catch(() => {}); }, 3000);
    return () => clearInterval(poll);
  }, [status, loadStatus]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, typing]);

  async function tap(action: Action) {
    if (typing) return;
    add({ from: "me", text: TITLES[action] });
    setTyping(true);
    try {
      const { reply } = await clientApi(`/api/chat/${token}`, {
        method: "POST", publicPage: true, body: JSON.stringify({ action }),
      }) as { reply: Reply };
      const qr = reply.qrString ? await QRCode.toDataURL(reply.qrString, { width: 520, margin: 2 }).catch(() => undefined) : undefined;
      add({ from: "biz", text: reply.text, buttons: reply.buttons, qr });
    } catch (e) {
      add({ from: "biz", text: e instanceof Error ? e.message : "No pudimos procesar tu respuesta. Intenta de nuevo.", buttons: [action] });
    } finally {
      setTyping(false);
    }
  }

  const lastWithButtons = [...messages].reverse().find(m => m.buttons?.length)?.id;
  const closed = status !== null && status.status !== "open";

  return (
    <main className="chat-page">
      <p className="chat-note">
        <strong>Vista previa del chat de WhatsApp.</strong> Los botones hacen el cobro CoDi real con Pey: «Pagar ahora» manda la notificación a la app del banco del celular registrado.
      </p>
      <section className="wa" aria-label="Conversación de WhatsApp con Puntualito">
        <header className="wa-head">
          <span className="wa-avatar" aria-hidden="true"><img src="/reloj.svg" alt="" /></span>
          <div className="wa-who">
            <strong>Puntualito <svg viewBox="0 0 24 24" aria-label="Cuenta verificada" role="img"><circle cx="12" cy="12" r="11" fill="#53bdeb" /><path d="M7 12.5l3.2 3.2L17 9" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg></strong>
            <small>Cuenta de empresa</small>
          </div>
        </header>

        <div className="wa-body" aria-live="polite">
          <span className="wa-day">Hoy</span>
          {missing && <div className="wa-bubble in"><p>Este cobro no existe. Pídele uno nuevo al negocio.</p></div>}
          {messages.map(m => (
            <div key={m.id} className={`wa-bubble ${m.from === "me" ? "out" : "in"}${m.receipt ? " receipt" : ""}`}>
              {m.qr && <img className="wa-qr" src={m.qr} alt="Código QR de CoDi para pagar" />}
              <p>{m.text}</p>
              {m.qr && <a className="wa-save" href={m.qr} download="codi-qr.png">Guardar QR</a>}
              <time>{m.time}{m.from === "me" && <span aria-hidden="true"> ✓✓</span>}</time>
              {m.buttons && m.buttons.length > 0 && (
                <div className="wa-buttons">
                  {m.buttons.map(action => (
                    <button key={action} type="button" onClick={() => tap(action)}
                      disabled={typing || closed || m.id !== lastWithButtons}>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" fill="currentColor" /></svg>
                      {TITLES[action]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {typing && <div className="wa-bubble in typing" aria-label="Puntualito está escribiendo"><span /><span /><span /></div>}
          <div ref={endRef} />
        </div>

        <footer className="wa-compose" aria-hidden="true">
          <span className="wa-input">Mensaje</span>
          <span className="wa-mic"><svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-2.1A7 7 0 0 0 19 12z" fill="currentColor" /></svg></span>
        </footer>
      </section>
    </main>
  );
}
