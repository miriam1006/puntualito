-- Puntualito: resolver adeudos "Por revisar", editar y dar de baja clientes, cobros programados.
-- Aplicar después de 202611140001_initial.sql.
begin;

-- ---------------------------------------------------------------------------
-- Columnas nuevas
-- ---------------------------------------------------------------------------

-- Cómo resolvió el comercio un adeudo en revisión. 'refund_needed' deja el adeudo en revisión
-- hasta que el comercio lo cierre después de devolver el dinero.
alter table public.dues
  add column review_resolution text check (review_resolution in ('paid','refund_needed','closed')),
  add column review_note text check (review_note is null or length(review_note) between 1 and 500),
  add column reviewed_at timestamptz,
  add column reviewed_by uuid references auth.users(id);
create index dues_review_idx on public.dues(merchant_id, created_at desc) where status = 'review';

-- Día del cobro: 1 (lunes) a 7 (domingo) si es semanal; 1 a 31 si es mensual (31 = último del mes).
alter table public.plans
  add column day_of_period smallint not null default 1,
  add column updated_at timestamptz not null default now(),
  add constraint plans_day_of_period_check check (
    (period = 'weekly' and day_of_period between 1 and 7) or (period = 'monthly' and day_of_period between 1 and 31)
  );
create index plans_merchant_idx on public.plans(merchant_id, created_at desc);

-- Un pago nuevo que manda a revisión un adeudo ya resuelto invalida la resolución anterior.
create function public.dues_reset_review() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'review' and old.status <> 'review' then
    new.review_resolution := null; new.review_note := null; new.reviewed_at := null; new.reviewed_by := null;
  end if;
  return new;
end;
$$;
create trigger dues_reset_review before update of status on public.dues
  for each row execute function public.dues_reset_review();

-- ---------------------------------------------------------------------------
-- Por revisar
-- ---------------------------------------------------------------------------

-- p_resolution:
--   'paid'          acepta lo recibido como pago del adeudo.
--   'refund_needed' anota que hay que devolver dinero (nota obligatoria); sigue en revisión.
--   'closed'        cierra la revisión: vuelve a 'paid' si ya tenía un pago válido, si no queda 'cancelled'.
create function public.resolve_due(
  p_due_id uuid, p_merchant_id uuid, p_actor_user_id uuid, p_resolution text, p_note text
) returns public.dues language plpgsql security definer set search_path = '' as $$
declare d public.dues; v_note text := nullif(trim(coalesce(p_note, '')), ''); v_paid_at timestamptz;
begin
  if p_resolution is null or p_resolution not in ('paid','refund_needed','closed') then raise exception 'invalid_resolution'; end if;
  if v_note is not null and length(v_note) > 500 then raise exception 'invalid_note'; end if;
  if p_resolution = 'refund_needed' and v_note is null then raise exception 'note_required'; end if;
  select du.* into d from public.dues du join public.merchants m on m.id = du.merchant_id
    where du.id = p_due_id and m.id = p_merchant_id and m.owner_user_id = p_actor_user_id for update of du;
  if not found then raise exception 'due_not_found'; end if;
  if d.status <> 'review' then raise exception 'invalid_due_state'; end if;

  if p_resolution = 'paid' then
    select min(paid_at) into v_paid_at from public.payment_receipts where due_id = d.id;
    update public.dues set status = 'paid', paid_at = coalesce(d.paid_at, v_paid_at, now())
      where id = d.id;
  elsif p_resolution = 'closed' then
    if d.paid_at is not null then
      update public.dues set status = 'paid' where id = d.id;
    else
      update public.dues set status = 'cancelled', cancelled_at = coalesce(d.cancelled_at, now()) where id = d.id;
    end if;
  end if;
  update public.dues set review_resolution = p_resolution, review_note = coalesce(v_note, review_note),
    reviewed_at = now(), reviewed_by = p_actor_user_id
    where id = d.id returning * into d;
  insert into public.audit_log (merchant_id, actor, action, details)
    values (d.merchant_id, p_actor_user_id::text, 'due.review_' || p_resolution,
      jsonb_build_object('due_id', d.id, 'status', d.status, 'note', v_note));
  return d;
end;
$$;

-- ---------------------------------------------------------------------------
-- Clientes
-- ---------------------------------------------------------------------------

create function public.update_customer(
  p_customer_id uuid, p_merchant_id uuid, p_actor_user_id uuid, p_name text, p_phone text, p_whatsapp_opt_in boolean
) returns public.customers language plpgsql security definer set search_path = '' as $$
declare c public.customers; v_before public.customers;
begin
  if p_name is null or length(trim(p_name)) not between 1 and 100 then raise exception 'invalid_name'; end if;
  if p_phone is not null and p_phone !~ '^[0-9]{10}$' then raise exception 'invalid_phone'; end if;
  if p_whatsapp_opt_in is null then raise exception 'invalid_customer_request'; end if;
  select cu.* into v_before from public.customers cu join public.merchants m on m.id = cu.merchant_id
    where cu.id = p_customer_id and m.id = p_merchant_id and m.owner_user_id = p_actor_user_id and cu.active
    for update of cu;
  if not found then raise exception 'customer_not_found'; end if;
  begin
    update public.customers set name = trim(p_name), phone = p_phone, whatsapp_opt_in = p_whatsapp_opt_in
      where id = v_before.id returning * into c;
  exception when unique_violation then raise exception 'customer_phone_taken';
  end;
  insert into public.audit_log (merchant_id, actor, action, details)
    values (c.merchant_id, p_actor_user_id::text, 'customer.updated', jsonb_build_object(
      'customer_id', c.id,
      'name_changed', v_before.name is distinct from c.name,
      'phone_changed', v_before.phone is distinct from c.phone,
      'whatsapp_opt_in', c.whatsapp_opt_in));
  return c;
end;
$$;

-- Dar de baja no borra nada: el cliente deja de aparecer, sus planes se detienen y ya no recibe push.
-- Sus adeudos abiertos siguen cobrables con QR desde el link.
create function public.deactivate_customer(p_customer_id uuid, p_merchant_id uuid, p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.customers; v_plans integer;
begin
  select cu.* into c from public.customers cu join public.merchants m on m.id = cu.merchant_id
    where cu.id = p_customer_id and m.id = p_merchant_id and m.owner_user_id = p_actor_user_id
    for update of cu;
  if not found then raise exception 'customer_not_found'; end if;
  if not c.active then return jsonb_build_object('customer_id', c.id, 'plans_deactivated', 0); end if;
  update public.customers set active = false where id = c.id;
  update public.plans set active = false, updated_at = now() where customer_id = c.id and active;
  get diagnostics v_plans = row_count;
  insert into public.audit_log (merchant_id, actor, action, details)
    values (c.merchant_id, p_actor_user_id::text, 'customer.deactivated',
      jsonb_build_object('customer_id', c.id, 'plans_deactivated', v_plans));
  return jsonb_build_object('customer_id', c.id, 'plans_deactivated', v_plans);
end;
$$;

-- ---------------------------------------------------------------------------
-- Cobros programados
-- ---------------------------------------------------------------------------

-- Primera fecha >= p_from que cae en el día del plan. Debe coincidir con nextDueDate en src/lib/plans.ts.
create function public.plan_next_date(p_period text, p_day integer, p_from date)
returns date language plpgsql immutable set search_path = '' as $$
declare v_month date; v_last integer; v_date date;
begin
  if p_from is null then raise exception 'invalid_date'; end if;
  if p_period = 'weekly' then
    if p_day is null or p_day not between 1 and 7 then raise exception 'invalid_plan_day'; end if;
    return p_from + ((p_day - extract(isodow from p_from)::integer + 7) % 7);
  elsif p_period = 'monthly' then
    if p_day is null or p_day not between 1 and 31 then raise exception 'invalid_plan_day'; end if;
    v_month := pg_catalog.make_date(extract(year from p_from)::integer, extract(month from p_from)::integer, 1);
    for i in 1..2 loop
      v_last := extract(day from ((v_month + interval '1 month')::date - 1))::integer;
      v_date := v_month + (least(p_day, v_last) - 1);
      if v_date >= p_from then return v_date; end if;
      v_month := (v_month + interval '1 month')::date;
    end loop;
  end if;
  raise exception 'invalid_plan_period';
end;
$$;

create function public.create_plan(
  p_merchant_id uuid, p_actor_user_id uuid, p_customer_id uuid, p_concept text, p_amount_cents integer,
  p_period text, p_day integer, p_start_today boolean
) returns public.plans language plpgsql security definer set search_path = '' as $$
declare m public.merchants; p public.plans; v_today date := (now() at time zone 'America/Mexico_City')::date;
begin
  if p_merchant_id is null or p_actor_user_id is null then raise exception 'invalid_plan_request'; end if;
  select * into m from public.merchants where id = p_merchant_id and owner_user_id = p_actor_user_id;
  if not found then raise exception 'merchant_not_found'; end if;
  if p_amount_cents is null or p_amount_cents < 1 or p_amount_cents > m.max_amount_cents then raise exception 'invalid_amount'; end if;
  if p_concept is null or length(trim(p_concept)) not between 1 and 100 then raise exception 'invalid_concept'; end if;
  if p_period is null or p_period not in ('weekly','monthly') then raise exception 'invalid_plan_period'; end if;
  if p_customer_id is null or not exists (
    select 1 from public.customers where id = p_customer_id and merchant_id = m.id and active
  ) then raise exception 'customer_not_found'; end if;
  insert into public.plans (merchant_id, customer_id, concept, amount_cents, period, day_of_period, next_due_date)
    values (m.id, p_customer_id, trim(p_concept), p_amount_cents, p_period, p_day,
      case when coalesce(p_start_today, false) then v_today else public.plan_next_date(p_period, p_day, v_today) end)
    returning * into p;
  insert into public.audit_log (merchant_id, actor, action, details)
    values (m.id, p_actor_user_id::text, 'plan.created', jsonb_build_object('plan_id', p.id, 'customer_id', p.customer_id));
  return p;
end;
$$;

create function public.deactivate_plan(p_plan_id uuid, p_merchant_id uuid, p_actor_user_id uuid)
returns public.plans language plpgsql security definer set search_path = '' as $$
declare p public.plans;
begin
  select pl.* into p from public.plans pl join public.merchants m on m.id = pl.merchant_id
    where pl.id = p_plan_id and m.id = p_merchant_id and m.owner_user_id = p_actor_user_id for update of pl;
  if not found then raise exception 'plan_not_found'; end if;
  if not p.active then return p; end if;
  update public.plans set active = false, updated_at = now() where id = p.id returning * into p;
  insert into public.audit_log (merchant_id, actor, action, details)
    values (p.merchant_id, p_actor_user_id::text, 'plan.deactivated', jsonb_build_object('plan_id', p.id));
  return p;
end;
$$;

-- Genera los adeudos vencidos de los planes activos. Idempotente: unique (plan_id, due_date) impide
-- duplicados y next_due_date avanza en la misma transacción. Si el job estuvo detenido, genera como
-- máximo 12 periodos atrasados por plan y salta el resto.
-- p_merchant_id null = todos los comercios (cron). p_actor_user_id null = el cron.
create function public.generate_due_dues(p_today date, p_merchant_id uuid, p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_today date := coalesce(p_today, (now() at time zone 'America/Mexico_City')::date);
  v_actor text := coalesce(p_actor_user_id::text, 'cron');
  p public.plans; d public.dues; v_next date; v_count integer;
  v_created jsonb := '[]'::jsonb; v_skipped integer := 0;
begin
  if p_actor_user_id is not null and (p_merchant_id is null or not exists (
    select 1 from public.merchants where id = p_merchant_id and owner_user_id = p_actor_user_id
  )) then raise exception 'merchant_not_found'; end if;

  for p in
    select pl.* from public.plans pl
      where pl.active and pl.next_due_date <= v_today and (p_merchant_id is null or pl.merchant_id = p_merchant_id)
      order by pl.next_due_date, pl.id
      for update skip locked
  loop
    if not exists (select 1 from public.customers where id = p.customer_id and active)
      or p.amount_cents > (select max_amount_cents from public.merchants where id = p.merchant_id) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_next := p.next_due_date;
    v_count := 0;
    while v_next <= v_today and v_count < 12 loop
      d := null;
      insert into public.dues (merchant_id, customer_id, plan_id, concept, amount_cents, due_date, created_by)
        values (p.merchant_id, p.customer_id, p.id, p.concept, p.amount_cents, v_next, p_actor_user_id)
        on conflict (plan_id, due_date) do nothing
        returning * into d;
      if d.id is not null then
        insert into public.audit_log (merchant_id, actor, action, details)
          values (p.merchant_id, v_actor, 'due.created', jsonb_build_object('due_id', d.id, 'plan_id', p.id, 'due_date', d.due_date));
        v_created := v_created || jsonb_build_object('due_id', d.id, 'plan_id', p.id, 'merchant_id', d.merchant_id,
          'customer_id', d.customer_id, 'concept', d.concept, 'amount_cents', d.amount_cents,
          'due_date', d.due_date, 'public_token', d.public_token);
      end if;
      v_count := v_count + 1;
      v_next := public.plan_next_date(p.period, p.day_of_period, v_next + 1);
    end loop;
    if v_next <= v_today then v_next := public.plan_next_date(p.period, p.day_of_period, v_today + 1); end if;
    update public.plans set next_due_date = v_next, updated_at = now() where id = p.id;
  end loop;
  return jsonb_build_object('today', v_today, 'created', v_created, 'skipped', v_skipped);
end;
$$;

-- Gancho para recordatorios (rama de WhatsApp): adeudos abiertos y vencidos a p_today cuyo cliente
-- aceptó WhatsApp. No envía nada ni guarda estado; quien envía decide la frecuencia.
create function public.due_reminder_candidates(p_today date, p_merchant_id uuid)
returns table (
  due_id uuid, merchant_id uuid, merchant_name text, customer_id uuid, customer_name text, phone text,
  concept text, amount_cents integer, due_date date, days_overdue integer, public_token text, plan_id uuid
) language sql stable security definer set search_path = '' as $$
  select d.id, d.merchant_id, m.name, c.id, c.name, c.phone, d.concept, d.amount_cents, d.due_date,
    (coalesce(p_today, (now() at time zone 'America/Mexico_City')::date) - d.due_date)::integer,
    d.public_token, d.plan_id
  from public.dues d
    join public.merchants m on m.id = d.merchant_id
    join public.customers c on c.id = d.customer_id
  where d.status = 'open' and c.active and c.whatsapp_opt_in and c.phone is not null
    and d.due_date <= coalesce(p_today, (now() at time zone 'America/Mexico_City')::date)
    and (p_merchant_id is null or d.merchant_id = p_merchant_id)
  order by d.due_date, d.id
  limit 1000;
$$;

revoke all on function public.dues_reset_review() from public, anon, authenticated;
revoke all on function public.resolve_due(uuid,uuid,uuid,text,text) from public, anon, authenticated;
revoke all on function public.update_customer(uuid,uuid,uuid,text,text,boolean) from public, anon, authenticated;
revoke all on function public.deactivate_customer(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.plan_next_date(text,integer,date) from public, anon, authenticated;
revoke all on function public.create_plan(uuid,uuid,uuid,text,integer,text,integer,boolean) from public, anon, authenticated;
revoke all on function public.deactivate_plan(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.generate_due_dues(date,uuid,uuid) from public, anon, authenticated;
revoke all on function public.due_reminder_candidates(date,uuid) from public, anon, authenticated;
grant execute on function public.resolve_due(uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.update_customer(uuid,uuid,uuid,text,text,boolean) to service_role;
grant execute on function public.deactivate_customer(uuid,uuid,uuid) to service_role;
grant execute on function public.plan_next_date(text,integer,date) to service_role;
grant execute on function public.create_plan(uuid,uuid,uuid,text,integer,text,integer,boolean) to service_role;
grant execute on function public.deactivate_plan(uuid,uuid,uuid) to service_role;
grant execute on function public.generate_due_dues(date,uuid,uuid) to service_role;
grant execute on function public.due_reminder_candidates(date,uuid) to service_role;

commit;
