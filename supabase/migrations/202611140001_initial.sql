-- Puntual: esquema inicial.
-- Aplicar en el SQL Editor de un proyecto NUEVO de Supabase.
-- Todo el acceso pasa por el servidor con la clave de servicio; el navegador
-- nunca lee ni escribe estas tablas directamente (RLS activo y sin políticas).
begin;

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------

create table public.merchants (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users(id),
  name text not null check (length(name) between 1 and 100),
  pey_api_key_id text not null unique,
  max_amount_cents integer not null default 800000 check (max_amount_cents between 1 and 100000000),
  grace_days integer not null default 5 check (grace_days between 0 and 60),
  next_num_ref integer not null default 1 check (next_num_ref between 1 and 10000000),
  created_at timestamptz not null default now()
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id),
  name text not null check (length(name) between 1 and 100),
  phone text check (phone ~ '^[0-9]{10}$'),
  email text check (email is null or length(email) between 3 and 254),
  whatsapp_opt_in boolean not null default false,
  -- Se aprende sola: 'push' o 'link' según el canal del último pago exitoso.
  preferred_channel text not null default 'unknown' check (preferred_channel in ('unknown','push','link')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (merchant_id, phone)
);
create index customers_merchant_idx on public.customers(merchant_id, name);

-- Cobros programados (mensualidades). El job que genera adeudos aún no existe.
create table public.plans (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id),
  customer_id uuid not null references public.customers(id),
  concept text not null check (length(concept) between 1 and 100),
  amount_cents integer not null check (amount_cents > 0),
  period text not null default 'monthly' check (period in ('weekly','monthly')),
  next_due_date date not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index plans_due_idx on public.plans(next_due_date) where active;

-- Un adeudo es lo que el cliente debe. Es lo único permanente; el link público apunta aquí.
create table public.dues (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id),
  customer_id uuid references public.customers(id),
  plan_id uuid references public.plans(id),
  concept text not null check (length(concept) between 1 and 100),
  amount_cents integer not null check (amount_cents > 0),
  due_date date not null default ((now() at time zone 'America/Mexico_City')::date),
  status text not null default 'open' check (status in ('open','paid','review','cancelled')),
  -- 64 caracteres hexadecimales al azar: nadie puede adivinar el link de otro adeudo.
  public_token text not null unique
    default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
    check (public_token ~ '^[0-9a-f]{64}$'),
  paid_at timestamptz,
  cancelled_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (plan_id, due_date)
);
create index dues_merchant_created_idx on public.dues(merchant_id, created_at desc);

-- Un intento es una solicitud concreta a Pey (un QR o un push) para cobrar un adeudo.
create table public.attempts (
  id uuid primary key default gen_random_uuid(),
  due_id uuid not null references public.dues(id),
  merchant_id uuid not null references public.merchants(id),
  kind text not null check (kind in ('qr','push')),
  status text not null default 'creating' check (status in ('creating','pending','paid','expired','failed','review')),
  amount_cents integer not null check (amount_cents > 0),
  num_ref text not null check (num_ref ~ '^[0-9]{1,7}$'),
  -- QR: id del QR (codiQrId). Push: transactionId devuelto por Pey.
  pey_ref text unique,
  qr_string text,
  codi_id text,
  transaction_id text unique,
  late_payment boolean not null default false,
  failure_code text,
  provider_requested_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  paid_at timestamptz,
  unique (merchant_id, num_ref)
);
-- Regla central: un solo intento vivo por adeudo.
create unique index attempts_one_live_per_due on public.attempts(due_id) where status in ('creating','pending');
create index attempts_merchant_created_idx on public.attempts(merchant_id, created_at desc);

create table public.webhook_events (
  webhook_id text primary key,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts integer not null default 0,
  outcome text,
  error text
);

-- Cada pago es un hecho financiero aparte, incluidos pagos tardíos o duplicados.
create table public.payment_receipts (
  transaction_id text primary key,
  attempt_id uuid not null references public.attempts(id),
  due_id uuid not null references public.dues(id),
  merchant_id uuid not null references public.merchants(id),
  webhook_id text not null references public.webhook_events(webhook_id),
  amount_cents integer not null check (amount_cents > 0),
  paid_at timestamptz not null,
  needs_review boolean not null default false,
  received_at timestamptz not null default now()
);
create index receipts_merchant_paid_idx on public.payment_receipts(merchant_id, paid_at);

create table public.audit_log (
  id bigint generated always as identity primary key,
  merchant_id uuid references public.merchants(id),
  actor text not null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.merchants enable row level security;
alter table public.customers enable row level security;
alter table public.plans enable row level security;
alter table public.dues enable row level security;
alter table public.attempts enable row level security;
alter table public.webhook_events enable row level security;
alter table public.payment_receipts enable row level security;
alter table public.audit_log enable row level security;

revoke all on public.merchants, public.customers, public.plans, public.dues, public.attempts,
  public.webhook_events, public.payment_receipts, public.audit_log from anon, authenticated;
grant all on public.merchants, public.customers, public.plans, public.dues, public.attempts,
  public.webhook_events, public.payment_receipts, public.audit_log to service_role;
grant usage, select on sequence public.audit_log_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- Funciones
-- ---------------------------------------------------------------------------

create function public.create_due(
  p_merchant_id uuid, p_actor_user_id uuid, p_customer_id uuid, p_concept text, p_amount_cents integer
) returns public.dues language plpgsql security definer set search_path = '' as $$
declare m public.merchants; d public.dues;
begin
  if p_merchant_id is null or p_actor_user_id is null then raise exception 'invalid_due_request'; end if;
  select * into m from public.merchants where id = p_merchant_id and owner_user_id = p_actor_user_id;
  if not found then raise exception 'merchant_not_found'; end if;
  if p_amount_cents is null or p_amount_cents < 1 or p_amount_cents > m.max_amount_cents then raise exception 'invalid_amount'; end if;
  if p_concept is null or length(trim(p_concept)) not between 1 and 100 then raise exception 'invalid_concept'; end if;
  if p_customer_id is not null and not exists (
    select 1 from public.customers where id = p_customer_id and merchant_id = m.id and active
  ) then raise exception 'customer_not_found'; end if;
  insert into public.dues (merchant_id, customer_id, concept, amount_cents, created_by)
    values (m.id, p_customer_id, trim(p_concept), p_amount_cents, p_actor_user_id) returning * into d;
  insert into public.audit_log (merchant_id, actor, action, details)
    values (m.id, p_actor_user_id::text, 'due.created', jsonb_build_object('due_id', d.id));
  return d;
end;
$$;

create function public.cancel_due(p_due_id uuid, p_merchant_id uuid, p_actor_user_id uuid)
returns public.dues language plpgsql security definer set search_path = '' as $$
declare d public.dues;
begin
  select du.* into d from public.dues du join public.merchants m on m.id = du.merchant_id
    where du.id = p_due_id and m.id = p_merchant_id and m.owner_user_id = p_actor_user_id for update of du;
  if not found then raise exception 'due_not_found'; end if;
  if d.status = 'cancelled' then return d; end if;
  if d.status <> 'open' then raise exception 'invalid_due_state'; end if;
  -- Cancelar aquí NO invalida el QR o push en Pey: un pago posterior se registra para revisión.
  update public.attempts set status = 'expired' where due_id = d.id and status in ('creating','pending');
  update public.dues set status = 'cancelled', cancelled_at = now() where id = d.id returning * into d;
  insert into public.audit_log (merchant_id, actor, action, details)
    values (d.merchant_id, p_actor_user_id::text, 'due.cancelled', jsonb_build_object('due_id', d.id));
  return d;
end;
$$;

-- Devuelve el intento vivo del adeudo o reserva uno nuevo. Nunca hay dos vivos a la vez.
-- La llamada a Pey ocurre después, fuera de esta transacción (ver claim_attempt_creation).
create function public.open_attempt(p_token text, p_kind text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.dues; a public.attempts; m public.merchants; v_phone text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' or p_kind is null or p_kind not in ('qr','push') then
    raise exception 'invalid_attempt_request';
  end if;
  select * into d from public.dues where public_token = p_token for update;
  if not found then raise exception 'due_not_found'; end if;
  if d.status <> 'open' then
    return jsonb_build_object('due_status', d.status, 'attempt', null, 'created', false);
  end if;
  select * into a from public.attempts where due_id = d.id and status in ('creating','pending') for update;
  if found then
    if a.expires_at > now() then
      return jsonb_build_object('due_status', d.status, 'attempt', to_jsonb(a), 'created', false);
    end if;
    update public.attempts set status = 'expired' where id = a.id;
  end if;
  if p_kind = 'push' then
    -- El push solo sale al celular registrado por el comercio, nunca a uno escrito en la página pública.
    select phone into v_phone from public.customers where id = d.customer_id and active;
    if v_phone is null then raise exception 'push_unavailable'; end if;
  end if;
  select * into m from public.merchants where id = d.merchant_id for update;
  if (select count(*) from public.attempts where merchant_id = m.id and created_at > now() - interval '1 minute') >= 30 then
    raise exception 'rate_limited';
  end if;
  if m.next_num_ref > 9999999 then raise exception 'reference_exhausted'; end if;
  insert into public.attempts (due_id, merchant_id, kind, amount_cents, num_ref, expires_at)
    values (d.id, m.id, p_kind, d.amount_cents, m.next_num_ref::text,
      now() + case when p_kind = 'push' then interval '6 minutes' else interval '10 minutes' end)
    returning * into a;
  update public.merchants set next_num_ref = next_num_ref + 1 where id = m.id;
  return jsonb_build_object('due_status', d.status, 'attempt', to_jsonb(a), 'created', true,
    'concept', d.concept, 'phone', v_phone);
end;
$$;

-- Reclama la creación en Pey exactamente una vez entre peticiones concurrentes.
-- Un timeout después de reclamar es ambiguo: no se crea otro intento hasta que este venza.
create function public.claim_attempt_creation(p_attempt_id uuid)
returns public.attempts language plpgsql security definer set search_path = '' as $$
declare a public.attempts;
begin
  if p_attempt_id is null then raise exception 'invalid_attempt_request'; end if;
  update public.attempts set provider_requested_at = now()
    where id = p_attempt_id and status = 'creating' and provider_requested_at is null
    returning * into a;
  return a;
end;
$$;

create function public.finalize_attempt(p_attempt_id uuid, p_pey_ref text, p_qr_string text, p_codi_id text)
returns public.attempts language plpgsql security definer set search_path = '' as $$
declare a public.attempts;
begin
  if p_attempt_id is null or length(trim(coalesce(p_pey_ref, ''))) = 0 then raise exception 'invalid_provider_response'; end if;
  select * into a from public.attempts where id = p_attempt_id for update;
  if not found then raise exception 'attempt_not_found'; end if;
  if a.kind = 'qr' and length(trim(coalesce(p_qr_string, ''))) = 0 then raise exception 'invalid_provider_response'; end if;
  if a.pey_ref is not null then
    if a.pey_ref <> p_pey_ref then raise exception 'provider_reference_conflict'; end if;
    return a;
  end if;
  if a.status <> 'creating' then raise exception 'invalid_attempt_state'; end if;
  update public.attempts set pey_ref = p_pey_ref, qr_string = p_qr_string, codi_id = p_codi_id, status = 'pending'
    where id = a.id returning * into a;
  return a;
end;
$$;

-- Solo para rechazos definitivos de Pey (4xx): libera el adeudo para un intento nuevo.
create function public.fail_attempt(p_attempt_id uuid, p_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.attempts set status = 'failed', failure_code = left(coalesce(p_code, 'unknown'), 64)
    where id = p_attempt_id and status = 'creating' and pey_ref is null;
end;
$$;

-- El handler HTTP DEBE verificar la firma Standard Webhooks sobre el body crudo antes de llamar aquí.
-- Una llamada = una transacción: evento, recibo, intento, adeudo y auditoría.
create function public.process_pey_payment(
  p_webhook_id text, p_payload jsonb, p_pey_api_key_id text, p_kind text, p_pey_ref text,
  p_num_ref text, p_transaction_id text, p_amount_cents integer, p_paid_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare e public.webhook_events; a public.attempts; d public.dues; r public.payment_receipts;
  v_attempt_id uuid; v_review boolean; v_late boolean; v_outcome text;
begin
  if length(trim(coalesce(p_webhook_id, ''))) = 0 or length(trim(coalesce(p_transaction_id, ''))) = 0
    or length(trim(coalesce(p_pey_ref, ''))) = 0 or length(trim(coalesce(p_pey_api_key_id, ''))) = 0
    or p_kind is null or p_kind not in ('qr','push')
    or p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or p_amount_cents is null or p_amount_cents < 1 or p_paid_at is null or not isfinite(p_paid_at) then
    raise exception 'invalid_payment';
  end if;
  insert into public.webhook_events (webhook_id, payload) values (p_webhook_id, p_payload) on conflict do nothing;
  select * into e from public.webhook_events where webhook_id = p_webhook_id for update;
  if e.payload <> p_payload then raise exception 'webhook_id_payload_conflict'; end if;
  if e.processed_at is not null then return jsonb_build_object('outcome', 'duplicate', 'retry', false); end if;
  update public.webhook_events set attempts = attempts + 1 where webhook_id = p_webhook_id;

  select at.id into v_attempt_id from public.attempts at join public.merchants m on m.id = at.merchant_id
    where at.pey_ref = p_pey_ref and at.kind = p_kind and m.pey_api_key_id = p_pey_api_key_id;
  if v_attempt_id is null and p_num_ref ~ '^[0-9]{1,7}$' then
    -- La llamada a Pey pudo tener éxito aunque nuestra respuesta se perdiera (timeout o fallo al
    -- guardar). Solo un webhook firmado con la referencia nunca reutilizada puede recuperarlo.
    select at.id into v_attempt_id from public.attempts at join public.merchants m on m.id = at.merchant_id
      where m.pey_api_key_id = p_pey_api_key_id and at.num_ref = p_num_ref and at.kind = p_kind
        and at.pey_ref is null and at.provider_requested_at is not null;
    if v_attempt_id is not null then
      update public.attempts set pey_ref = p_pey_ref where id = v_attempt_id and pey_ref is null;
      insert into public.audit_log (merchant_id, actor, action, details)
        select merchant_id, 'pey_webhook', 'attempt.provider_reference_recovered', jsonb_build_object('attempt_id', id)
        from public.attempts where id = v_attempt_id;
    end if;
  end if;
  if v_attempt_id is null then
    update public.webhook_events set error = 'attempt_not_found_or_key_mismatch', outcome = 'unmatched' where webhook_id = p_webhook_id;
    return jsonb_build_object('outcome', 'unmatched', 'retry', true);
  end if;

  -- Mismo orden de bloqueo que open_attempt (adeudo y luego intento) para evitar interbloqueos.
  select du.* into d from public.dues du
    where du.id = (select due_id from public.attempts where id = v_attempt_id) for update;
  select * into a from public.attempts where id = v_attempt_id for update;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_transaction_id, 0));
  select * into r from public.payment_receipts where transaction_id = p_transaction_id;
  if found then
    if r.attempt_id <> a.id or r.amount_cents <> p_amount_cents or r.paid_at <> p_paid_at then
      update public.webhook_events set outcome = 'transaction_conflict', error = 'transaction_conflict', processed_at = now() where webhook_id = p_webhook_id;
      insert into public.audit_log (merchant_id, actor, action, details)
        values (a.merchant_id, 'pey_webhook', 'payment.transaction_conflict', jsonb_build_object('attempt_id', a.id, 'transaction_id', p_transaction_id));
      return jsonb_build_object('outcome', 'transaction_conflict', 'retry', false);
    end if;
    update public.webhook_events set outcome = 'duplicate_transaction', processed_at = now(), error = null where webhook_id = p_webhook_id;
    return jsonb_build_object('outcome', 'duplicate_transaction', 'retry', false);
  end if;

  -- A revisión: monto distinto, segundo pago del mismo intento, o el adeudo ya no estaba abierto
  -- (por ejemplo, el cliente pagó el QR y después aprobó un push anterior).
  v_review := a.amount_cents <> p_amount_cents or a.transaction_id is not null or a.status = 'review' or d.status <> 'open';
  v_late := a.status in ('expired','failed') or p_paid_at > a.expires_at;
  insert into public.payment_receipts (transaction_id, attempt_id, due_id, merchant_id, webhook_id, amount_cents, paid_at, needs_review)
    values (p_transaction_id, a.id, d.id, a.merchant_id, p_webhook_id, p_amount_cents, p_paid_at, v_review);
  if v_review then
    update public.attempts set status = 'review', late_payment = late_payment or v_late where id = a.id;
    update public.dues set status = 'review' where id = d.id;
    v_outcome := 'review';
  else
    update public.attempts set status = 'paid', transaction_id = p_transaction_id, paid_at = p_paid_at, late_payment = v_late where id = a.id;
    update public.dues set status = 'paid', paid_at = p_paid_at where id = d.id;
    if d.customer_id is not null then
      update public.customers set preferred_channel = case when a.kind = 'push' then 'push' else 'link' end where id = d.customer_id;
    end if;
    v_outcome := case when v_late then 'paid_late' else 'paid' end;
  end if;
  update public.webhook_events set processed_at = now(), outcome = v_outcome, error = null where webhook_id = p_webhook_id;
  insert into public.audit_log (merchant_id, actor, action, details)
    values (a.merchant_id, 'pey_webhook', 'payment.' || v_outcome, jsonb_build_object('due_id', d.id, 'attempt_id', a.id, 'transaction_id', p_transaction_id));
  return jsonb_build_object('outcome', v_outcome, 'due_id', d.id, 'attempt_id', a.id, 'retry', false);
end;
$$;

revoke all on function public.create_due(uuid,uuid,uuid,text,integer) from public, anon, authenticated;
revoke all on function public.cancel_due(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.open_attempt(text,text) from public, anon, authenticated;
revoke all on function public.claim_attempt_creation(uuid) from public, anon, authenticated;
revoke all on function public.finalize_attempt(uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.fail_attempt(uuid,text) from public, anon, authenticated;
revoke all on function public.process_pey_payment(text,jsonb,text,text,text,text,text,integer,timestamptz) from public, anon, authenticated;
grant execute on function public.create_due(uuid,uuid,uuid,text,integer) to service_role;
grant execute on function public.cancel_due(uuid,uuid,uuid) to service_role;
grant execute on function public.open_attempt(text,text) to service_role;
grant execute on function public.claim_attempt_creation(uuid) to service_role;
grant execute on function public.finalize_attempt(uuid,text,text,text) to service_role;
grant execute on function public.fail_attempt(uuid,text) to service_role;
grant execute on function public.process_pey_payment(text,jsonb,text,text,text,text,text,integer,timestamptz) to service_role;

commit;
