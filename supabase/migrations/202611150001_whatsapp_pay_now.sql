-- "Pagar ahora" pasa de botón URL a respuesta rápida: el cliente toca el botón en WhatsApp
-- y Puntualito manda el push de CoDi sin abrir ningún link. Se registra como 'button_pay_now'.
-- Quita el check de purpose sin depender del nombre que le puso Postgres.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.whatsapp_messages'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%purpose%'
  loop
    execute format('alter table public.whatsapp_messages drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.whatsapp_messages add constraint whatsapp_messages_purpose_check
  check (purpose in ('due_created','reminder','qr','later_ack','payment_received','reply',
                     'button_pay_now','button_pay_qr','button_later','inbound'));
