-- Prueba del flujo de cobro. Corre en una transacción y termina con ROLLBACK: no deja datos.
-- Ejecutar en un proyecto de prueba después de aplicar la migración.
begin;

do $$
declare
  v_user uuid; v_merchant uuid; v_customer uuid; v_other_user uuid;
  d public.dues; d2 public.dues; d3 public.dues; d4 public.dues; d5 public.dues;
  r jsonb; r2 jsonb; a_id uuid; push_id uuid; qr_id uuid; claimed public.attempts;
  ts timestamptz := now();
begin
  insert into auth.users (email) values ('owner@test.example') returning id into v_user;
  insert into auth.users (email) values ('other@test.example') returning id into v_other_user;
  insert into public.merchants (owner_user_id, name, pey_api_key_id) values (v_user, 'Gimnasio Prueba', 'key_test') returning id into v_merchant;
  insert into public.customers (merchant_id, name, phone) values (v_merchant, 'Ana', '5512345678') returning id into v_customer;

  -- 1. Crear adeudo: valida dueño, monto y cliente.
  d := public.create_due(v_merchant, v_user, v_customer, ' Mensualidad ', 60000);
  assert d.status = 'open' and d.concept = 'Mensualidad' and d.public_token ~ '^[0-9a-f]{64}$', 'adeudo creado';
  begin perform public.create_due(v_merchant, v_other_user, null, 'x', 100); assert false, 'otro usuario no puede crear';
  exception when others then assert sqlerrm = 'merchant_not_found', sqlerrm; end;
  begin perform public.create_due(v_merchant, v_user, null, 'x', 800001); assert false, 'monto sobre el límite';
  exception when others then assert sqlerrm = 'invalid_amount', sqlerrm; end;

  -- 2. Un solo intento vivo: la segunda llamada devuelve el mismo.
  r := public.open_attempt(d.public_token, 'qr');
  assert (r->>'created')::boolean and r->'attempt'->>'status' = 'creating', 'intento reservado';
  a_id := (r->'attempt'->>'id')::uuid;
  r2 := public.open_attempt(d.public_token, 'push');
  assert not (r2->>'created')::boolean and (r2->'attempt'->>'id')::uuid = a_id, 'no hay segundo intento vivo';

  -- 3. Solo una petición reclama la llamada a Pey.
  claimed := public.claim_attempt_creation(a_id);
  assert claimed.id = a_id, 'primer reclamo';
  claimed := public.claim_attempt_creation(a_id);
  assert claimed.id is null, 'segundo reclamo vacío';
  perform public.finalize_attempt(a_id, 'QR-1', 'qrstring', null);

  -- 4. Pago correcto: intento y adeudo pagados, canal aprendido.
  r := public.process_pey_payment('wh-1', '{"type":"codi.qr.payment_received"}', 'key_test', 'qr', 'QR-1', '1', 'tx-1', 60000, ts);
  assert r->>'outcome' = 'paid', r::text;
  assert (select status from public.dues where id = d.id) = 'paid', 'adeudo pagado';
  assert (select preferred_channel from public.customers where id = v_customer) = 'link', 'canal aprendido';
  -- Webhook repetido: no duplica.
  r := public.process_pey_payment('wh-1', '{"type":"codi.qr.payment_received"}', 'key_test', 'qr', 'QR-1', '1', 'tx-1', 60000, ts);
  assert r->>'outcome' = 'duplicate', r::text;
  assert (select count(*) from public.payment_receipts where due_id = d.id) = 1, 'un solo recibo';
  -- Adeudo pagado: ya no abre intentos.
  r := public.open_attempt(d.public_token, 'qr');
  assert r->>'due_status' = 'paid' and r->'attempt' = 'null'::jsonb, 'pagado no abre intento';
  -- API key ajena: no encuentra el cobro y pide reintento.
  r := public.process_pey_payment('wh-x', '{"type":"codi.qr.payment_received"}', 'otra_key', 'qr', 'QR-1', null, 'tx-x', 60000, ts);
  assert r->>'outcome' = 'unmatched' and (r->>'retry')::boolean, r::text;

  -- 5. Push vencido que se paga tarde, y luego un QR pagado: el segundo va a revisión.
  d2 := public.create_due(v_merchant, v_user, v_customer, 'Diciembre', 60000);
  r := public.open_attempt(d2.public_token, 'push');
  assert r->>'phone' = '5512345678' and r->'attempt'->>'kind' = 'push', 'push usa el celular registrado';
  push_id := (r->'attempt'->>'id')::uuid;
  perform public.claim_attempt_creation(push_id);
  perform public.finalize_attempt(push_id, 'TX-PUSH', null, '00000000000000000001');
  update public.attempts set expires_at = now() - interval '1 minute' where id = push_id;
  r := public.open_attempt(d2.public_token, 'qr');
  assert (r->>'created')::boolean and (r->'attempt'->>'id')::uuid <> push_id, 'vencido permite uno nuevo';
  qr_id := (r->'attempt'->>'id')::uuid;
  assert (select status from public.attempts where id = push_id) = 'expired', 'el anterior quedó vencido';
  perform public.claim_attempt_creation(qr_id);
  perform public.finalize_attempt(qr_id, 'QR-2', 'qrstring2', null);
  r := public.process_pey_payment('wh-2', '{"type":"codi.pn.payment_received"}', 'key_test', 'push', 'TX-PUSH', null, 'TX-PUSH', 60000, now());
  assert r->>'outcome' = 'paid_late', r::text;
  assert (select preferred_channel from public.customers where id = v_customer) = 'push', 'canal actualizado';
  r := public.process_pey_payment('wh-3', '{"type":"codi.qr.payment_received"}', 'key_test', 'qr', 'QR-2', '3', 'tx-3', 60000, now());
  assert r->>'outcome' = 'review', r::text;
  assert (select status from public.dues where id = d2.id) = 'review', 'pago repetido a revisión';
  assert (select count(*) from public.payment_receipts where due_id = d2.id) = 2, 'ambos pagos registrados';

  -- 6. Monto distinto: a revisión.
  d3 := public.create_due(v_merchant, v_user, null, 'Mostrador', 35000);
  begin perform public.open_attempt(d3.public_token, 'push'); assert false, 'push sin cliente';
  exception when others then assert sqlerrm = 'push_unavailable', sqlerrm; end;
  r := public.open_attempt(d3.public_token, 'qr');
  a_id := (r->'attempt'->>'id')::uuid;
  perform public.claim_attempt_creation(a_id);
  perform public.finalize_attempt(a_id, 'QR-3', 'qrstring3', null);
  r := public.process_pey_payment('wh-4', '{"type":"codi.qr.payment_received"}', 'key_test', 'qr', 'QR-3', null, 'tx-4', 100, now());
  assert r->>'outcome' = 'review', r::text;

  -- 7. Timeout al crear: el webhook recupera el intento por numRef.
  d4 := public.create_due(v_merchant, v_user, null, 'Recuperado', 100);
  r := public.open_attempt(d4.public_token, 'qr');
  a_id := (r->'attempt'->>'id')::uuid;
  perform public.claim_attempt_creation(a_id);
  r := public.process_pey_payment('wh-5', '{"type":"codi.qr.payment_received"}', 'key_test', 'qr', 'QR-LOST', r->'attempt'->>'num_ref', 'tx-5', 100, now());
  assert r->>'outcome' = 'paid', r::text;
  assert (select pey_ref from public.attempts where id = a_id) = 'QR-LOST', 'referencia recuperada';

  -- 8. Rechazo definitivo de Pey libera el adeudo; cancelar lo cierra.
  d5 := public.create_due(v_merchant, v_user, null, 'Cancelado', 100);
  r := public.open_attempt(d5.public_token, 'qr');
  a_id := (r->'attempt'->>'id')::uuid;
  perform public.claim_attempt_creation(a_id);
  perform public.fail_attempt(a_id, 'rejected_400');
  r := public.open_attempt(d5.public_token, 'qr');
  assert (r->>'created')::boolean and (r->'attempt'->>'id')::uuid <> a_id, 'fallido permite reintentar';
  begin perform public.cancel_due(d5.id, v_merchant, v_other_user); assert false, 'otro usuario no cancela';
  exception when others then assert sqlerrm = 'due_not_found', sqlerrm; end;
  perform public.cancel_due(d5.id, v_merchant, v_user);
  r := public.open_attempt(d5.public_token, 'qr');
  assert r->>'due_status' = 'cancelled', 'cancelado no abre intento';
  begin perform public.cancel_due(d.id, v_merchant, v_user); assert false, 'pagado no se cancela';
  exception when others then assert sqlerrm = 'invalid_due_state', sqlerrm; end;

  -- 9. Conciliación manual ("Verificar pago"): mismo process_pey_payment con webhook_id
  -- determinista por transacción. Repetirla y el webhook real posterior no duplican.
  d5 := public.create_due(v_merchant, v_user, v_customer, 'Conciliado', 100);
  r := public.open_attempt(d5.public_token, 'push');
  push_id := (r->'attempt'->>'id')::uuid;
  perform public.claim_attempt_creation(push_id);
  perform public.finalize_attempt(push_id, 'TX-REC', null, '00000000000000000002');
  r := public.process_pey_payment('reconcile:TX-REC',
    '{"source":"pey_reconcile","type":"codi.pn.payment_received","transactionId":"TX-REC","amount":0.01,"datePaid":1790724758}',
    'key_test', 'push', 'TX-REC', null, 'TX-REC', 100, to_timestamp(1790724758));
  assert r->>'outcome' in ('paid', 'paid_late'), r::text;
  assert (select status from public.dues where id = d5.id) = 'paid', 'conciliado pagado';
  r := public.process_pey_payment('reconcile:TX-REC',
    '{"datePaid":1790724758,"amount":0.01,"transactionId":"TX-REC","type":"codi.pn.payment_received","source":"pey_reconcile"}',
    'key_test', 'push', 'TX-REC', null, 'TX-REC', 100, to_timestamp(1790724758));
  assert r->>'outcome' = 'duplicate', r::text;
  r := public.process_pey_payment('wh-rec', '{"type":"codi.pn.payment_received"}', 'key_test', 'push', 'TX-REC',
    null, 'TX-REC', 100, to_timestamp(1790724758));
  assert r->>'outcome' = 'duplicate_transaction', r::text;
  assert (select count(*) from public.payment_receipts where due_id = d5.id) = 1, 'un solo recibo conciliado';

  raise notice 'payment_flow: todas las comprobaciones pasaron';
end $$;

rollback;
