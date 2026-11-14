-- Prueba: comercio sin apiKeyId, webhook retenido y ligado posterior. Termina con ROLLBACK.
begin;

do $$
declare
  v_user uuid; v_other_user uuid; v_merchant uuid; v_other uuid; d public.dues; r jsonb; a_id uuid;
  ts timestamptz := now();
  v_payload jsonb := '{"type":"codi.qr.payment_received","apiKeyId":"key_real"}';
begin
  insert into auth.users (email) values ('owner-bind@test.example') returning id into v_user;
  insert into auth.users (email) values ('other-bind@test.example') returning id into v_other_user;
  -- 1. El comercio se crea sin apiKeyId (varios pueden quedar en null).
  insert into public.merchants (owner_user_id, name) values (v_user, 'Sin key') returning id into v_merchant;
  insert into public.merchants (owner_user_id, name) values (v_other_user, 'Otro sin key') returning id into v_other;
  begin insert into public.merchants (owner_user_id, name, pey_api_key_id) values (v_other_user, 'x', ' ');
    assert false, 'apiKeyId vacío rechazado';
  exception when others then assert sqlstate in ('23514', '23505'), sqlerrm; end;

  -- 2. Sin apiKeyId se puede crear adeudo e intento QR.
  d := public.create_due(v_merchant, v_user, null, 'Prueba', 1);
  r := public.open_attempt(d.public_token, 'qr');
  a_id := (r->'attempt'->>'id')::uuid;
  perform public.claim_attempt_creation(a_id);
  perform public.finalize_attempt(a_id, 'QR-B', 'qrstring', null);

  -- 3. Con el comercio sin ligar, process_pey_payment no encuentra el cobro.
  r := public.process_pey_payment('wh-b0', v_payload, 'key_real', 'qr', 'QR-B', '1', 'tx-b0', 1, ts);
  assert r->>'outcome' = 'unmatched', r::text;

  -- 4. Webhook retenido: guarda el evento, liga el comercio dueño del intento, no paga.
  r := public.hold_pey_payment('wh-b1', v_payload, 'key_real', 'qr', 'QR-B');
  assert r->>'outcome' = 'held' and r->>'binding' = 'bound' and (r->>'retry')::boolean, r::text;
  assert (select pey_api_key_id from public.merchants where id = v_merchant) = 'key_real', 'comercio ligado';
  assert (select status from public.dues where id = d.id) = 'open', 'retenido no paga';
  assert (select outcome from public.webhook_events where webhook_id = 'wh-b1') = 'held', 'evento guardado';
  assert (select processed_at from public.webhook_events where webhook_id = 'wh-b1') is null, 'evento sin procesar';
  -- Mismo webhook_id con otro payload: conflicto.
  begin perform public.hold_pey_payment('wh-b1', '{"type":"otro"}', 'key_real', 'qr', 'QR-B'); assert false, 'payload distinto';
  exception when others then assert sqlerrm = 'webhook_id_payload_conflict', sqlerrm; end;

  -- 5. Un comercio ligado nunca cambia de apiKeyId; la key no se liga a otro comercio.
  assert public.bind_pey_api_key_id(v_merchant, 'key_real', 'test') = 'already_bound', 'idempotente';
  assert public.bind_pey_api_key_id(v_merchant, 'key_atacante', 'test') = 'mismatch', 'no reemplaza';
  assert public.bind_pey_api_key_id(v_other, 'key_real', 'test') = 'key_in_use', 'key única';
  assert public.bind_pey_api_key_id(gen_random_uuid(), 'key_x', 'test') = 'merchant_not_found', 'comercio inexistente';
  r := public.hold_pey_payment('wh-b2', v_payload, 'key_atacante', 'qr', 'QR-B');
  assert r->>'binding' = 'mismatch', r::text;
  assert (select pey_api_key_id from public.merchants where id = v_merchant) = 'key_real', 'sigue ligado a la original';
  r := public.hold_pey_payment('wh-b3', v_payload, 'key_real', 'qr', 'NO-EXISTE');
  assert r->>'binding' = 'attempt_not_found', r::text;

  -- 6. Ya configurada la key, el reintento del webhook retenido se procesa normalmente.
  r := public.process_pey_payment('wh-b1', v_payload, 'key_real', 'qr', 'QR-B', '1', 'tx-b1', 1, ts);
  assert r->>'outcome' = 'paid', r::text;
  assert (select status from public.dues where id = d.id) = 'paid', 'adeudo pagado';
  r := public.hold_pey_payment('wh-b1', v_payload, 'key_real', 'qr', 'QR-B');
  assert (select outcome from public.webhook_events where webhook_id = 'wh-b1') = 'paid', 'retener no pisa un evento procesado';

  -- 7. La función no se expone a roles del navegador.
  assert not has_function_privilege('anon', 'public.hold_pey_payment(text,jsonb,text,text,text)', 'execute'), 'anon sin acceso';
  assert not has_function_privilege('authenticated', 'public.bind_pey_api_key_id(uuid,text,text)', 'execute'), 'authenticated sin acceso';
  raise notice 'pey_api_key_binding: todas las comprobaciones pasaron';
end $$;

rollback;
