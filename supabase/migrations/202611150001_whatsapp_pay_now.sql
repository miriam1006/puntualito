-- "Pagar ahora" pasa de botón URL a respuesta rápida: el cliente toca el botón en WhatsApp
-- y Puntualito manda el push de CoDi sin abrir ningún link. Se registra como 'button_pay_now'.
alter table public.whatsapp_messages drop constraint whatsapp_messages_purpose_check;
alter table public.whatsapp_messages add constraint whatsapp_messages_purpose_check
  check (purpose in ('due_created','reminder','qr','later_ack','payment_received','reply',
                     'button_pay_now','button_pay_qr','button_later','inbound'));
