-- Puntualito: el comercio puede existir antes de conocer el apiKeyId de Pey.
-- El portal de Pey no muestra ese ID; llega en los webhooks firmados. Se liga una sola vez
-- (desde PEY_API_KEY_ID o desde el primer webhook verificado) y nunca se reemplaza.
begin;

alter table public.merchants alter column pey_api_key_id drop not null;
alter table public.merchants add constraint merchants_pey_api_key_id_format
  check (pey_api_key_id is null or length(trim(pey_api_key_id)) between 1 and 128);

-- Liga el apiKeyId a un comercio que todavía no lo tiene. Un comercio ya ligado no cambia.
create function public.bind_pey_api_key_id(p_merchant_id uuid, p_pey_api_key_id text, p_actor text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_current text;
begin
  if p_merchant_id is null or length(trim(coalesce(p_pey_api_key_id, ''))) not between 1 and 128 then
    raise exception 'invalid_api_key_id';
  end if;
  select pey_api_key_id into v_current from public.merchants where id = p_merchant_id for update;
  if not found then return 'merchant_not_found'; end if;
  if v_current is not null then
    return case when v_current = p_pey_api_key_id then 'already_bound' else 'mismatch' end;
  end if;
  if exists (select 1 from public.merchants where pey_api_key_id = p_pey_api_key_id) then return 'key_in_use'; end if;
  update public.merchants set pey_api_key_id = p_pey_api_key_id where id = p_merchant_id;
  insert into public.audit_log (merchant_id, actor, action, details)
    values (p_merchant_id, left(coalesce(p_actor, 'system'), 64), 'merchant.pey_api_key_bound',
      jsonb_build_object('pey_api_key_id', p_pey_api_key_id));
  return 'bound';
end;
$$;

-- Webhook firmado con PEY_API_KEY_ID sin configurar: guarda el evento SIN marcar nada como pagado,
-- para procesarlo después (reintento de Pey o "Verificar pago"), y liga el apiKeyId al comercio
-- dueño del intento si aún no tenía uno. El handler DEBE verificar la firma antes de llamar aquí.
create function public.hold_pey_payment(
  p_webhook_id text, p_payload jsonb, p_pey_api_key_id text, p_kind text, p_pey_ref text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare e public.webhook_events; v_merchant_id uuid; v_binding text;
begin
  if length(trim(coalesce(p_webhook_id, ''))) = 0 or length(trim(coalesce(p_pey_ref, ''))) = 0
    or length(trim(coalesce(p_pey_api_key_id, ''))) not between 1 and 128
    or p_kind is null or p_kind not in ('qr','push')
    or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'invalid_payment';
  end if;
  insert into public.webhook_events (webhook_id, payload) values (p_webhook_id, p_payload) on conflict do nothing;
  select * into e from public.webhook_events where webhook_id = p_webhook_id for update;
  if e.payload <> p_payload then raise exception 'webhook_id_payload_conflict'; end if;
  if e.processed_at is null then
    update public.webhook_events set outcome = 'held', error = 'pey_api_key_id_not_configured'
      where webhook_id = p_webhook_id;
  end if;
  select merchant_id into v_merchant_id from public.attempts where pey_ref = p_pey_ref and kind = p_kind;
  v_binding := case when v_merchant_id is null then 'attempt_not_found'
    else public.bind_pey_api_key_id(v_merchant_id, p_pey_api_key_id, 'pey_webhook') end;
  return jsonb_build_object('outcome', 'held', 'binding', v_binding, 'retry', true);
end;
$$;

revoke all on function public.bind_pey_api_key_id(uuid,text,text) from public, anon, authenticated;
revoke all on function public.hold_pey_payment(text,jsonb,text,text,text) from public, anon, authenticated;
grant execute on function public.bind_pey_api_key_id(uuid,text,text) to service_role;
grant execute on function public.hold_pey_payment(text,jsonb,text,text,text) to service_role;

commit;
