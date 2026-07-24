-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Tracking de correos (aperturas + clics) — estilo Yesware
-- "Copiar con seguimiento" genera un envío único (email_sends); el correo lleva
-- un pixel + enlaces reescritos que pegan a /api/track (endpoint público) y
-- registran eventos (email_events) vía service role.
--
-- ⚠️ Activar SOLO con el dominio bien autenticado (SPF/DKIM/DMARC): los pixeles
-- y enlaces reescritos son señal de spam y pueden afectar entregabilidad.
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists email_sends (
  id           uuid primary key default gen_random_uuid(),   -- = id de seguimiento
  template_id  uuid references email_templates(id) on delete set null,
  sender_id    uuid references auth.users(id) on delete set null,
  recipient    text not null default '',                     -- nombre/correo que anota el usuario (referencia)
  subject      text not null default '',
  created_at   timestamptz not null default now()
);
create index if not exists email_sends_sender_idx on email_sends (sender_id, created_at desc);

create table if not exists email_events (
  id          bigserial primary key,
  send_id     uuid not null references email_sends(id) on delete cascade,
  type        text not null check (type in ('open', 'click')),
  url         text,          -- destino del clic (solo type='click')
  ip          text,
  ua          text,          -- user-agent (aprox. dispositivo/cliente)
  created_at  timestamptz not null default now()
);
create index if not exists email_events_send_idx on email_events (send_id, created_at);

alter table email_sends  enable row level security;
alter table email_events enable row level security;

-- Envíos: el equipo autenticado crea y consulta (biblioteca compartida, como plantillas).
drop policy if exists email_sends_all on email_sends;
create policy email_sends_all on email_sends
  for all to authenticated using (true) with check (true);

-- Eventos: SOLO lectura para autenticados. La escritura la hace el endpoint
-- público /api/track con service role (bypassa RLS); nadie inserta eventos a mano.
drop policy if exists email_events_read on email_events;
create policy email_events_read on email_events
  for select to authenticated using (true);
