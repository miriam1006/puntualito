-- Puntualito: mensajes de WhatsApp Business (Cloud API) y recordatorios pedidos por el cliente.
-- Aplicar después de 202611140001_initial.sql y 202611140002_review_and_plans.sql. Igual que el resto: RLS activo y sin políticas.
begin;

create table public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id),
  due_id uuid references public.dues(id),
  customer_id uuid references public.customers(id),
  direction text not null check (direction in ('out','in')),
  -- Para qué se mandó (o qué respondió el cliente). 'due_created' y 'payment_received' salen una sola vez por adeudo.
  purpose text not null check (purpose in ('due_created','reminder','qr','later_ack','payment_received','reply','button_pay_qr','button_later','inbound')),
  kind text not null check (kind in ('template','text','image','button','interactive','unsupported')),
  phone text not null check (phone ~ '^[0-9]{10}$'),
  -- wamid que asigna Meta. Nulo mientras el envío está reservado y no hay respuesta.
  wa_message_id text unique check (wa_message_id is null or length(wa_message_id) between 1 and 256),
  context_wa_message_id text check (context_wa_message_id is null or length(context_wa_message_id) <= 256),
  body text check (body is null or length(body) <= 1024),
  status text not null default 'queued' check (status in ('queued','sent','delivered','read','failed','received')),
  error_code text check (error_code is null or length(error_code) <= 64),
  error_title text check (error_title is null or length(error_title) <= 256),
  status_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index whatsapp_messages_once_per_due on public.whatsapp_messages(due_id, purpose)
  where direction = 'out' and purpose in ('due_created','payment_received');
create index whatsapp_messages_due_idx on public.whatsapp_messages(due_id, created_at);
create index whatsapp_messages_merchant_idx on public.whatsapp_messages(merchant_id, created_at desc);
create index whatsapp_messages_phone_idx on public.whatsapp_messages(phone, created_at desc) where direction = 'out';

-- "Más tarde": el cron de recordatorios lee las solicitudes pendientes (sent_at nulo).
create table public.reminder_requests (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id),
  due_id uuid not null references public.dues(id),
  customer_id uuid references public.customers(id),
  source text not null default 'whatsapp' check (source in ('whatsapp','panel')),
  requested_at timestamptz not null default now(),
  remind_at timestamptz not null,
  sent_at timestamptz
);
create unique index reminder_requests_one_pending on public.reminder_requests(due_id) where sent_at is null;
create index reminder_requests_due_idx on public.reminder_requests(remind_at) where sent_at is null;

alter table public.whatsapp_messages enable row level security;
alter table public.reminder_requests enable row level security;
revoke all on public.whatsapp_messages, public.reminder_requests from anon, authenticated;
grant all on public.whatsapp_messages, public.reminder_requests to service_role;

-- Meta puede entregar los estados en desorden: nunca se retrocede (read no vuelve a delivered).
create function public.record_whatsapp_status(
  p_wa_message_id text, p_status text, p_at timestamptz, p_error_code text, p_error_title text
) returns public.whatsapp_messages language plpgsql security definer set search_path = '' as $$
declare m public.whatsapp_messages;
begin
  if length(trim(coalesce(p_wa_message_id, ''))) = 0 or p_status is null
    or p_status not in ('sent','delivered','read','failed') then
    raise exception 'invalid_status';
  end if;
  update public.whatsapp_messages set status = p_status, status_at = coalesce(p_at, now()),
      error_code = case when p_status = 'failed' then left(p_error_code, 64) else error_code end,
      error_title = case when p_status = 'failed' then left(p_error_title, 256) else error_title end
    where wa_message_id = p_wa_message_id and direction = 'out'
      and (array_position(array['queued','sent','delivered','read','failed'], p_status)
        > array_position(array['queued','sent','delivered','read','failed'], status))
    returning * into m;
  return m;
end;
$$;

-- Registra (o pospone) el recordatorio de un adeudo abierto. Devuelve null si ya no está abierto.
create function public.request_due_reminder(p_due_id uuid, p_source text, p_remind_at timestamptz)
returns public.reminder_requests language plpgsql security definer set search_path = '' as $$
declare d public.dues; r public.reminder_requests;
begin
  if p_due_id is null or p_remind_at is null or p_source is null or p_source not in ('whatsapp','panel') then
    raise exception 'invalid_reminder_request';
  end if;
  select * into d from public.dues where id = p_due_id for update;
  if not found or d.status <> 'open' then return null; end if;
  update public.reminder_requests set remind_at = p_remind_at, requested_at = now(), source = p_source
    where due_id = d.id and sent_at is null returning * into r;
  if not found then
    insert into public.reminder_requests (merchant_id, due_id, customer_id, source, remind_at)
      values (d.merchant_id, d.id, d.customer_id, p_source, p_remind_at) returning * into r;
  end if;
  insert into public.audit_log (merchant_id, actor, action, details)
    values (d.merchant_id, p_source, 'reminder.requested', jsonb_build_object('due_id', d.id, 'remind_at', p_remind_at));
  return r;
end;
$$;

revoke all on function public.record_whatsapp_status(text,text,timestamptz,text,text) from public, anon, authenticated;
revoke all on function public.request_due_reminder(uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function public.record_whatsapp_status(text,text,timestamptz,text,text) to service_role;
grant execute on function public.request_due_reminder(uuid,text,timestamptz) to service_role;

commit;
