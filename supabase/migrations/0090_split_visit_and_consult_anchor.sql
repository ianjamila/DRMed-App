-- 0090_split_visit_and_consult_anchor.sql
-- Two changes:
--  (1) visits.visit_group_id — links the two halves (Doctor PF / Lab & Services)
--      of one counter encounter that was split into two visits. NULL for
--      standalone (non-split) visits. Additive, nullable; no RLS change (the
--      patient policy keys on patient_id), no payment-gating/audit change.
--  (2) Manual consultation pricing: introduce one generic CONSULT anchor
--      service (price 0 — the amount is typed at the counter and snapshotted
--      onto each test_requests line) and deactivate the per-specialty
--      consultation catalog so it stops appearing in pickers. Existing rows are
--      kept for FK/history; their prices are already snapshotted on released
--      test_requests.

alter table public.visits
  add column if not exists visit_group_id uuid;

create index if not exists idx_visits_visit_group_id
  on public.visits(visit_group_id)
  where visit_group_id is not null;

-- Generic consultation anchor. price_php = 0; reception types the real fee.
insert into public.services (code, name, kind, price_php, is_active, requires_signoff)
values ('CONSULT', 'Consultation', 'doctor_consultation', 0, true, false)
on conflict (code) do update
  set name = excluded.name,
      kind = excluded.kind,
      is_active = true,
      requires_signoff = false;

-- Retire the per-specialty consultation catalog (kept for FK/history).
update public.services
  set is_active = false
  where kind = 'doctor_consultation'
    and code <> 'CONSULT';
