-- Prueba de la migración de WhatsApp. Corre en una transacción y termina con ROLLBACK: no deja datos.
-- Ejecutar después de aplicar 202611140001_initial.sql y 202611140002_whatsapp.sql.
begin;

do $$
declare
  v_user uuid; v_merchant uuid; v_customer uuid; d public.dues; d2 public.dues;
  m public.whatsapp_messages; rr public.reminder_requests; rr2 public.reminder_requests; msg_id uuid;
begin
  insert into auth.users (email) values ('wa-owner@test.example') returning id into v_user;
  insert into public.merchants (owner_user_id, name, pey_api_key_id) values (v_user, 'Gimnasio WA', 'key_wa') returning id into v_merchant;
  insert into public.customers (merchant_id, name, phone, whatsapp_opt_in) values (v_merchant, 'Ana', '5512345678', true) returning id into v_customer;
  d := public.create_due(v_merchant, v_user, v_customer, 'Mensualidad', 60000);

  -- 1. Plantilla de cobro nuevo: una sola por adeudo.
  insert into public.whatsapp_messages (merchant_id, due_id, customer_id, direction, purpose, kind, phone, body)
    values (v_merchant, d.id, v_customer, 'out', 'due_created', 'template', '5512345678', 'Cobro') returning id into msg_id;
  begin
    insert into public.whatsapp_messages (merchant_id, due_id, customer_id, direction, purpose, kind, phone)
      values (v_merchant, d.id, v_customer, 'out', 'due_created', 'template', '5512345678');
    assert false, 'segunda plantilla de cobro nuevo';
  exception when unique_violation then null; end;
  -- Los QR sí pueden repetirse.
  insert into public.whatsapp_messages (merchant_id, due_id, direction, purpose, kind, phone) values (v_merchant, d.id, 'out', 'qr', 'image', '5512345678');
  insert into public.whatsapp_messages (merchant_id, due_id, direction, purpose, kind, phone) values (v_merchant, d.id, 'out', 'qr', 'image', '5512345678');
  begin
    insert into public.whatsapp_messages (merchant_id, direction, purpose, kind, phone) values (v_merchant, 'out', 'reply', 'text', '+525512345678');
    assert false, 'celular con formato inválido';
  exception when check_violation then null; end;

  -- 2. Estados: avanzan, nunca retroceden; desconocidos no hacen nada.
  update public.whatsapp_messages set wa_message_id = 'wamid.1' where id = msg_id;
  m := public.record_whatsapp_status('wamid.1', 'delivered', now(), null, null);
  assert m.status = 'delivered', 'entregado';
  m := public.record_whatsapp_status('wamid.1', 'sent', now(), null, null);
  assert m.id is null and (select status from public.whatsapp_messages where id = msg_id) = 'delivered', 'sent tardío no retrocede';
  m := public.record_whatsapp_status('wamid.1', 'read', now(), null, null);
  assert m.status = 'read', 'leído';
  m := public.record_whatsapp_status('wamid.otro', 'read', now(), null, null);
  assert m.id is null, 'wamid desconocido';
  begin perform public.record_whatsapp_status('wamid.1', 'queued', now(), null, null); assert false, 'estado inválido';
  exception when others then assert sqlerrm = 'invalid_status', sqlerrm; end;
  insert into public.whatsapp_messages (merchant_id, due_id, direction, purpose, kind, phone, wa_message_id)
    values (v_merchant, d.id, 'out', 'reply', 'text', '5512345678', 'wamid.2');
  m := public.record_whatsapp_status('wamid.2', 'failed', now(), '131030', 'Recipient phone number not in allowed list');
  assert m.status = 'failed' and m.error_code = '131030', 'fallido con código';

  -- 3. Entrante: el wamid es único (Meta reintenta webhooks).
  insert into public.whatsapp_messages (merchant_id, due_id, direction, purpose, kind, phone, wa_message_id, status)
    values (v_merchant, d.id, 'in', 'button_later', 'button', '5512345678', 'wamid.in1', 'received');
  begin
    insert into public.whatsapp_messages (merchant_id, due_id, direction, purpose, kind, phone, wa_message_id, status)
      values (v_merchant, d.id, 'in', 'button_later', 'button', '5512345678', 'wamid.in1', 'received');
    assert false, 'entrante duplicado';
  exception when unique_violation then null; end;
  m := public.record_whatsapp_status('wamid.in1', 'read', now(), null, null);
  assert m.id is null, 'los estados no tocan mensajes entrantes';

  -- 4. "Más tarde": un recordatorio pendiente por adeudo; repetir lo pospone.
  rr := public.request_due_reminder(d.id, 'whatsapp', now() + interval '1 day');
  assert rr.id is not null and rr.customer_id = v_customer and rr.merchant_id = v_merchant, 'recordatorio creado';
  rr2 := public.request_due_reminder(d.id, 'whatsapp', now() + interval '2 days');
  assert rr2.id = rr.id and rr2.remind_at > rr.remind_at, 'mismo recordatorio pospuesto';
  assert (select count(*) from public.reminder_requests where due_id = d.id) = 1, 'uno solo pendiente';
  update public.reminder_requests set sent_at = now() where id = rr.id;
  rr2 := public.request_due_reminder(d.id, 'whatsapp', now() + interval '1 day');
  assert rr2.id <> rr.id, 'tras enviarse, se puede pedir otro';
  assert (select count(*) from public.audit_log where action = 'reminder.requested' and merchant_id = v_merchant) = 3, 'auditado';
  -- Adeudo cancelado: no agenda nada.
  d2 := public.create_due(v_merchant, v_user, v_customer, 'Cancelado', 100);
  perform public.cancel_due(d2.id, v_merchant, v_user);
  rr := public.request_due_reminder(d2.id, 'whatsapp', now() + interval '1 day');
  assert rr.id is null, 'cancelado no agenda';
  begin perform public.request_due_reminder(d.id, 'sms', now()); assert false, 'fuente inválida';
  exception when others then assert sqlerrm = 'invalid_reminder_request', sqlerrm; end;

  -- 5. Pago recibido: una sola vez por adeudo.
  insert into public.whatsapp_messages (merchant_id, due_id, direction, purpose, kind, phone)
    values (v_merchant, d.id, 'out', 'payment_received', 'text', '5512345678');
  begin
    insert into public.whatsapp_messages (merchant_id, due_id, direction, purpose, kind, phone)
      values (v_merchant, d.id, 'out', 'payment_received', 'template', '5512345678');
    assert false, 'segundo pago recibido';
  exception when unique_violation then null; end;

  -- 6. RLS activo y sin acceso para anon/authenticated.
  assert (select relrowsecurity from pg_class where oid = 'public.whatsapp_messages'::regclass), 'RLS mensajes';
  assert (select relrowsecurity from pg_class where oid = 'public.reminder_requests'::regclass), 'RLS recordatorios';
  assert not has_table_privilege('anon', 'public.whatsapp_messages', 'select'), 'anon sin acceso';
  assert not has_table_privilege('authenticated', 'public.reminder_requests', 'select'), 'authenticated sin acceso';
  assert not has_function_privilege('anon', 'public.request_due_reminder(uuid,text,timestamptz)', 'execute'), 'anon sin función';
  assert (select count(*) from pg_policies where tablename in ('whatsapp_messages','reminder_requests')) = 0, 'sin políticas';

  raise notice 'whatsapp_flow: todas las comprobaciones pasaron';
end $$;

rollback;
