-- =============================================================================
-- 0027_critical_value_alerts.sql
-- =============================================================================
-- Adds critical-low / critical-high bounds to the per-band reference range
-- table, plus a critical_alerts table that records every value that
-- crossed a critical threshold at finalise time. The notification bell
-- subscribes to inserts on this table so pathologists + admins are paged
-- in real time when, e.g., glucose comes back at 850 mg/dL.
--
-- Detection lives in app code (the structured-form finalise action),
-- not a Postgres trigger. A trigger would be elegant but harder to
-- iterate on as detection rules evolve (and the trigger version of the
-- existing flagging code was dropped in 0010 for this reason).
-- =============================================================================

alter table public.result_template_param_ranges
  add column critical_low_si    numeric,
  add column critical_high_si   numeric,
  add column critical_low_conv  numeric,
  add column critical_high_conv numeric;

create table public.critical_alerts (
  id                uuid primary key default gen_random_uuid(),
  result_id         uuid not null references public.results(id) on delete cascade,
  test_request_id   uuid not null references public.test_requests(id) on delete cascade,
  parameter_id      uuid not null references public.result_template_params(id) on delete cascade,
  -- One of 'low' / 'high' so the UI can render a directional icon.
  direction         text not null check (direction in ('low', 'high')),
  -- Snapshot the value + threshold so the alert remains meaningful even
  -- if the underlying range row is edited later.
  observed_value_si numeric,
  threshold_si      numeric,
  parameter_name    text not null,
  -- Optional patient context for the bell to render without joins.
  patient_id        uuid references public.patients(id),
  patient_drm_id    text,
  -- Acknowledgement state. Pathologist clicks "ack" once they've called
  -- the attending physician.
  acknowledged_at   timestamptz,
  acknowledged_by   uuid references auth.users(id),
  created_at        timestamptz not null default now()
);

create index idx_critical_alerts_unacked
  on public.critical_alerts(created_at desc)
  where acknowledged_at is null;
create index idx_critical_alerts_test_request
  on public.critical_alerts(test_request_id, created_at desc);

alter table public.critical_alerts enable row level security;

create policy "critical_alerts: staff read"
  on public.critical_alerts for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

create policy "critical_alerts: lab worker insert"
  on public.critical_alerts for insert to authenticated
  with check (public.has_role(array['medtech', 'pathologist', 'admin', 'xray_technician']));

create policy "critical_alerts: pathologist/admin acknowledge"
  on public.critical_alerts for update to authenticated
  using (public.has_role(array['pathologist', 'admin']))
  with check (public.has_role(array['pathologist', 'admin']));

-- Realtime: pathologists + admin subscribe to inserts via the bell.
do $$
begin
  alter publication supabase_realtime add table public.critical_alerts;
exception when duplicate_object then null;
end$$;
