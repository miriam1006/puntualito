-- Prueba de "Por revisar", edición de clientes y cobros programados.
-- Corre en una transacción y termina con ROLLBACK: no deja datos. Requiere todas las migraciones.
begin;

do $$
declare
  v_user uuid; v_other_user uuid; v_merchant uuid; v_other_merchant uuid; v_ana uuid; v_beto uuid; v_caro uuid;
  d public.dues; c public.customers; p public.plans; p2 public.plans; p3 public.plans;
  r jsonb; a_id uuid; v_today date := (now() at time zone 'America/Mexico_City')::date;
begin
  insert into auth.users (email) values ('owner@test.example') returning id into v_user;
  insert into auth.users (email) values ('other@test.example') returning id into v_other_user;
  insert into public.merchants (owner_user_id, name, pey_api_key_id) values (v_user, 'Gimnasio Prueba', 'key_test') returning id into v_merchant;
  insert into public.merchants (owner_user_id, name, pey_api_key_id) values (v_other_user, 'Otro', 'key_other') returning id into v_other_merchant;
  insert into public.customers (merchant_id, name, phone, whatsapp_opt_in) values (v_merchant, 'Ana', '5512345678', true) returning id into v_ana;
  insert into public.customers (merchant_id, name, phone) values (v_merchant, 'Beto', '5587654321') returning id into v_beto;
  insert into public.customers (merchant_id, name) values (v_merchant, 'Caro') returning id into v_caro;

  -- 1. Monto distinto: a revisión; reembolso pendiente exige nota y sigue en revisión; cerrar lo cancela.
  d := public.create_due(v_merchant, v_user, v_ana, 'Mensualidad', 60000);
  r := public.open_attempt(d.public_token, 'qr');
  a_id := (r->'attempt'->>'id')::uuid;
  perform public.claim_attempt_creation(a_id);
  perform public.finalize_attempt(a_id, 'QR-R1', 'qr', null);
  r := public.process_pey_payment('wh-r1', '{"type":"codi.qr.payment_received"}', 'key_test', 'qr', 'QR-R1', null, 'tx-r1', 100, now());
  assert r->>'outcome' = 'review', r::text;
  begin perform public.resolve_due(d.id, v_merchant, v_other_user, 'paid', null); assert false, 'otro usuario no resuelve';
  exception when others then assert sqlerrm = 'due_not_found', sqlerrm; end;
  begin perform public.resolve_due(d.id, v_merchant, v_user, 'refund_needed', '  '); assert false, 'reembolso sin nota';
  exception when others then assert sqlerrm = 'note_required', sqlerrm; end;
  begin perform public.resolve_due(d.id, v_merchant, v_user, 'forgive', null); assert false, 'resolución inválida';
  exception when others then assert sqlerrm = 'invalid_resolution', sqlerrm; end;
  d := public.resolve_due(d.id, v_merchant, v_user, 'refund_needed', ' Devolver $1 por transferencia ');
  assert d.status = 'review' and d.review_resolution = 'refund_needed' and d.review_note = 'Devolver $1 por transferencia', 'reembolso anotado';
  d := public.resolve_due(d.id, v_merchant, v_user, 'closed', null);
  assert d.status = 'cancelled' and d.cancelled_at is not null and d.review_resolution = 'closed', 'cerrado sin pago queda cancelado';
  assert d.review_note = 'Devolver $1 por transferencia', 'cerrar sin nota conserva la anterior';
  assert (select count(*) from public.audit_log where details->>'due_id' = d.id::text and action like 'due.review_%') = 2, 'auditoría de revisión';
  begin perform public.resolve_due(d.id, v_merchant, v_user, 'closed', null); assert false, 'ya no está en revisión';
  exception when others then assert sqlerrm = 'invalid_due_state', sqlerrm; end;

  -- 2. Pago repetido sobre un adeudo pagado: cerrar lo regresa a pagado; un pago nuevo reinicia la revisión.
  d := public.create_due(v_merchant, v_user, v_ana, 'Repetido', 100);
  r := public.open_attempt(d.public_token, 'qr');
  a_id := (r->'attempt'->>'id')::uuid;
  perform public.claim_attempt_creation(a_id);
  perform public.finalize_attempt(a_id, 'QR-R2', 'qr', null);
  r := public.process_pey_payment('wh-r2', '{"type":"codi.qr.payment_received"}', 'key_test', 'qr', 'QR-R2', null, 'tx-r2', 100, now());
  assert r->>'outcome' = 'paid', r::text;
  r := public.process_pey_payment('wh-r3', '{"type":"codi.qr.payment_received"}', 'key_test', 'qr', 'QR-R2', null, 'tx-r3', 100, now());
  assert r->>'outcome' = 'review', r::text;
  d := public.resolve_due(d.id, v_merchant, v_user, 'closed', 'Se devolvió el segundo pago');
  assert d.status = 'paid' and d.paid_at is not null, 'cerrado con pago válido queda pagado';
  r := public.process_pey_payment('wh-r4', '{"type":"codi.qr.payment_received"}', 'key_test', 'qr', 'QR-R2', null, 'tx-r4', 100, now());
  select * into d from public.dues where id = d.id;
  assert d.status = 'review' and d.review_resolution is null and d.review_note is null, 'pago nuevo reinicia la revisión';

  -- 3. Marcar pagado toma la fecha del recibo.
  d := public.create_due(v_merchant, v_user, null, 'Mostrador', 35000);
  r := public.open_attempt(d.public_token, 'qr');
  a_id := (r->'attempt'->>'id')::uuid;
  perform public.claim_attempt_creation(a_id);
  perform public.finalize_attempt(a_id, 'QR-R5', 'qr', null);
  perform public.process_pey_payment('wh-r5', '{"type":"codi.qr.payment_received"}', 'key_test', 'qr', 'QR-R5', null, 'tx-r5', 30000, '2026-11-01T12:00:00Z');
  d := public.resolve_due(d.id, v_merchant, v_user, 'paid', 'Aceptamos $300 por promoción');
  assert d.status = 'paid' and d.paid_at = '2026-11-01T12:00:00Z'::timestamptz and d.review_resolution = 'paid', 'marcado pagado';
  d := public.create_due(v_merchant, v_user, null, 'Abierto', 100);
  begin perform public.resolve_due(d.id, v_merchant, v_user, 'paid', null); assert false, 'abierto no se resuelve';
  exception when others then assert sqlerrm = 'invalid_due_state', sqlerrm; end;

  -- 4. Editar cliente: normalizado por el servidor, celular único por comercio, solo el dueño.
  c := public.update_customer(v_beto, v_merchant, v_user, ' Alberto ', '5511112222', true);
  assert c.name = 'Alberto' and c.phone = '5511112222' and c.whatsapp_opt_in, 'cliente editado';
  begin perform public.update_customer(v_beto, v_merchant, v_user, 'Alberto', '5512345678', true); assert false, 'celular repetido';
  exception when others then assert sqlerrm = 'customer_phone_taken', sqlerrm; end;
  begin perform public.update_customer(v_beto, v_merchant, v_user, 'Alberto', '55 1111', true); assert false, 'celular inválido';
  exception when others then assert sqlerrm = 'invalid_phone', sqlerrm; end;
  begin perform public.update_customer(v_beto, v_other_merchant, v_other_user, 'X', null, false); assert false, 'otro comercio';
  exception when others then assert sqlerrm = 'customer_not_found', sqlerrm; end;
  c := public.update_customer(v_beto, v_merchant, v_user, 'Alberto', null, false);
  assert c.phone is null, 'se puede quitar el celular';
  assert (select count(*) from public.audit_log where action = 'customer.updated' and details->>'customer_id' = v_beto::text) = 2, 'auditoría de cliente';

  -- 5. plan_next_date coincide con nextDueDate de src/lib/plans.ts (mismos casos que tests/plans.test.ts).
  assert public.plan_next_date('weekly', 1, '2026-11-14') = '2026-11-16', 'sábado a lunes';
  assert public.plan_next_date('weekly', 6, '2026-11-14') = '2026-11-14', 'mismo día de la semana';
  assert public.plan_next_date('weekly', 5, '2026-11-14') = '2026-11-20', 'sábado a viernes';
  assert public.plan_next_date('monthly', 14, '2026-11-14') = '2026-11-14', 'mismo día del mes';
  assert public.plan_next_date('monthly', 10, '2026-11-14') = '2026-12-10', 'mes siguiente';
  assert public.plan_next_date('monthly', 31, '2026-11-14') = '2026-11-30', 'último día de noviembre';
  assert public.plan_next_date('monthly', 5, '2026-12-20') = '2027-01-05', 'cambio de año';
  assert public.plan_next_date('monthly', 31, '2027-02-01') = '2027-02-28', 'febrero normal';
  assert public.plan_next_date('monthly', 30, '2028-02-01') = '2028-02-29', 'febrero bisiesto';
  begin perform public.plan_next_date('weekly', 8, '2026-11-14'); assert false, 'día inválido';
  exception when others then assert sqlerrm = 'invalid_plan_day', sqlerrm; end;

  -- 6. Crear plan: valida cliente, monto y día.
  begin perform public.create_plan(v_merchant, v_other_user, v_ana, 'x', 100, 'monthly', 1, true); assert false, 'otro usuario';
  exception when others then assert sqlerrm = 'merchant_not_found', sqlerrm; end;
  begin perform public.create_plan(v_merchant, v_user, null, 'x', 100, 'monthly', 1, true); assert false, 'plan sin cliente';
  exception when others then assert sqlerrm = 'customer_not_found', sqlerrm; end;
  begin perform public.create_plan(v_merchant, v_user, v_ana, 'x', 800001, 'monthly', 1, true); assert false, 'monto';
  exception when others then assert sqlerrm = 'invalid_amount', sqlerrm; end;
  begin perform public.create_plan(v_merchant, v_user, v_ana, 'x', 100, 'weekly', 9, false); assert false, 'día semanal';
  exception when others then assert sqlerrm = 'invalid_plan_day', sqlerrm; end;
  p := public.create_plan(v_merchant, v_user, v_ana, ' Mensualidad gym ', 50000, 'monthly', 1, true);
  assert p.next_due_date = v_today and p.concept = 'Mensualidad gym' and p.day_of_period = 1, 'primer cobro hoy';

  -- 7. Generar: crea el adeudo de hoy una sola vez, desde el panel (dueño) o el cron.
  begin perform public.generate_due_dues(null, v_merchant, v_other_user); assert false, 'otro usuario no genera';
  exception when others then assert sqlerrm = 'merchant_not_found', sqlerrm; end;
  r := public.generate_due_dues(null, v_merchant, v_user);
  assert jsonb_array_length(r->'created') = 1 and (r->'created'->0->>'plan_id')::uuid = p.id, r::text;
  select * into d from public.dues where id = (r->'created'->0->>'due_id')::uuid;
  assert d.status = 'open' and d.due_date = v_today and d.amount_cents = 50000 and d.customer_id = v_ana and d.created_by = v_user, 'adeudo generado';
  assert (select next_due_date from public.plans where id = p.id) = public.plan_next_date('monthly', 1, v_today + 1), 'plan avanzó';
  r := public.generate_due_dues(null, v_merchant, v_user);
  assert jsonb_array_length(r->'created') = 0, 'segunda corrida no duplica';
  r := public.generate_due_dues(null, null, null);
  assert jsonb_array_length(r->'created') = 0, 'cron tampoco duplica';
  -- Aunque next_due_date retroceda, unique (plan_id, due_date) impide el duplicado.
  update public.plans set next_due_date = v_today where id = p.id;
  r := public.generate_due_dues(null, null, null);
  assert jsonb_array_length(r->'created') = 0 and (select count(*) from public.dues where plan_id = p.id) = 1, 'idempotente por fecha';
  -- El adeudo generado se cobra como cualquier otro.
  r := public.open_attempt(d.public_token, 'push');
  assert (r->>'created')::boolean and r->>'phone' = '5512345678', 'adeudo generado es cobrable';

  -- 8. Atrasos: genera cada periodo vencido, máximo 12, y salta al siguiente futuro.
  p2 := public.create_plan(v_merchant, v_user, v_ana, 'Clase semanal', 100, 'weekly', 1, false);
  assert p2.next_due_date = public.plan_next_date('weekly', 1, v_today), 'sin primer cobro hoy usa el día del plan';
  update public.plans set next_due_date = '2026-10-05' where id = p2.id;
  r := public.generate_due_dues('2026-11-02', v_merchant, null);
  assert jsonb_array_length(r->'created') = 5, r::text;
  assert (select next_due_date from public.plans where id = p2.id) = '2026-11-09', 'semanal avanzó';
  p3 := public.create_plan(v_merchant, v_user, v_ana, 'Atrasado', 100, 'monthly', 10, false);
  update public.plans set next_due_date = '2025-01-10' where id = p3.id;
  r := public.generate_due_dues('2026-11-14', v_merchant, null);
  assert (select count(*) from public.dues where plan_id = p3.id) = 12, 'máximo 12 atrasados';
  assert (select next_due_date from public.plans where id = p3.id) = '2026-12-10', 'salta al siguiente futuro';
  assert (select count(*) from public.audit_log where action = 'due.created' and actor = 'cron' and details->>'plan_id' = p3.id::text) = 12, 'auditoría del cron';

  -- 9. Monto sobre el límite del comercio: se salta sin avanzar.
  update public.plans set next_due_date = '2026-11-20' where id = p2.id;
  update public.merchants set max_amount_cents = 50 where id = v_merchant;
  r := public.generate_due_dues('2026-11-30', v_merchant, null);
  assert (r->>'skipped')::integer >= 1 and jsonb_array_length(r->'created') = 0, r::text;
  assert (select next_due_date from public.plans where id = p2.id) = '2026-11-20', 'no avanza si se salta';
  update public.merchants set max_amount_cents = 800000 where id = v_merchant;

  -- 10. Recordatorios: adeudos abiertos vencidos de clientes con WhatsApp.
  assert exists (select 1 from public.due_reminder_candidates(v_today, v_merchant) where plan_id = p2.id and due_date = '2026-10-05' and days_overdue = v_today - '2026-10-05'::date), 'candidato vencido';
  assert not exists (select 1 from public.due_reminder_candidates('2026-10-04', v_merchant) where plan_id = p2.id), 'aún no vence';
  assert not exists (select 1 from public.due_reminder_candidates(v_today, v_other_merchant)), 'solo su comercio';

  -- 11. Baja de cliente: detiene sus planes, sin push ni recordatorios, y ya no se edita.
  r := public.deactivate_customer(v_ana, v_merchant, v_user);
  assert (r->>'plans_deactivated')::integer = 3, r::text;
  assert not (select active from public.customers where id = v_ana), 'cliente inactivo';
  assert not exists (select 1 from public.plans where customer_id = v_ana and active), 'planes detenidos';
  assert not exists (select 1 from public.due_reminder_candidates(v_today, v_merchant) where customer_id = v_ana), 'sin recordatorios';
  r := public.deactivate_customer(v_ana, v_merchant, v_user);
  assert (r->>'plans_deactivated')::integer = 0, 'baja repetida no hace nada';
  begin perform public.update_customer(v_ana, v_merchant, v_user, 'Ana', null, false); assert false, 'inactivo no se edita';
  exception when others then assert sqlerrm = 'customer_not_found', sqlerrm; end;
  begin perform public.create_plan(v_merchant, v_user, v_ana, 'x', 100, 'monthly', 1, true); assert false, 'plan para inactivo';
  exception when others then assert sqlerrm = 'customer_not_found', sqlerrm; end;
  begin perform public.deactivate_customer(v_caro, v_other_merchant, v_other_user); assert false, 'baja ajena';
  exception when others then assert sqlerrm = 'customer_not_found', sqlerrm; end;

  -- 12. Desactivar plan.
  p := public.create_plan(v_merchant, v_user, v_caro, 'Taller', 100, 'weekly', 3, true);
  begin perform public.deactivate_plan(p.id, v_other_merchant, v_other_user); assert false, 'plan ajeno';
  exception when others then assert sqlerrm = 'plan_not_found', sqlerrm; end;
  p := public.deactivate_plan(p.id, v_merchant, v_user);
  assert not p.active, 'plan desactivado';
  r := public.generate_due_dues(null, v_merchant, v_user);
  assert not exists (select 1 from jsonb_array_elements(r->'created') e where (e->>'plan_id')::uuid = p.id), 'plan inactivo no genera';

  -- 13. Solo el servidor (service_role) puede ejecutar las funciones nuevas.
  assert not has_function_privilege('anon', 'public.resolve_due(uuid,uuid,uuid,text,text)', 'execute'), 'anon sin resolve_due';
  assert not has_function_privilege('authenticated', 'public.generate_due_dues(date,uuid,uuid)', 'execute'), 'authenticated sin generar';
  assert has_function_privilege('service_role', 'public.generate_due_dues(date,uuid,uuid)', 'execute'), 'service_role genera';

  raise notice 'review_and_plans: todas las comprobaciones pasaron';
end $$;

rollback;
