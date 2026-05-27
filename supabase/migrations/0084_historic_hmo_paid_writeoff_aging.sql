-- =============================================================================
-- 0084_historic_hmo_paid_writeoff_aging.sql
-- =============================================================================
-- 12.B follow-up. Adds three companion flows to the historic-HMO ledger:
--   1) Mark-as-paid          (status: pending/overdue → paid; posts settlement JE)
--   2) Write-off             (status: pending/overdue → written_off; posts DR 6920 JE)
--   3) Aging snapshots       (point-in-time aging rollup)
--
-- All three update existing rows; no operational subledger involvement.
-- =============================================================================

-- 1) Allow 'written_off' on status + add provenance columns ------------------
alter table public.historic_hmo_claims
  drop constraint historic_hmo_claims_status_check;
alter table public.historic_hmo_claims
  add constraint historic_hmo_claims_status_check
    check (status in ('paid', 'pending', 'overdue', 'unknown', 'written_off'));

alter table public.historic_hmo_claims
  add column paid_recorded_by_staff_id   uuid references public.staff_profiles(id),
  add column paid_recorded_at            timestamptz,
  add column paid_payment_method         text
    check (paid_payment_method is null or paid_payment_method in ('bpi', 'bdo', 'cash', 'gcash', 'other')),
  add column wrote_off_by_staff_id       uuid references public.staff_profiles(id),
  add column wrote_off_at                timestamptz,
  add column wrote_off_journal_entry_id  uuid references public.journal_entries(id) on delete set null,
  add column write_off_reason            text;

comment on column public.historic_hmo_claims.paid_recorded_by_staff_id is '12.B: staff who recorded the historic claim as paid (does not equal date_paid).';
comment on column public.historic_hmo_claims.paid_recorded_at is '12.B: wall-clock when paid_recorded_by_staff_id confirmed the payment.';
comment on column public.historic_hmo_claims.paid_payment_method is '12.B: which cash/bank account received the HMO settlement.';
comment on column public.historic_hmo_claims.wrote_off_by_staff_id is '12.B: staff who wrote off this claim.';
comment on column public.historic_hmo_claims.wrote_off_at is '12.B: wall-clock when the write-off was recorded.';
comment on column public.historic_hmo_claims.wrote_off_journal_entry_id is '12.B: DR 6920 / CR 1110 JE that booked the write-off.';
comment on column public.historic_hmo_claims.write_off_reason is '12.B: free-text reason from staff (e.g., HMO denied, no follow-up possible).';

-- 2) Aging snapshots table --------------------------------------------------
-- One row per (snapshot_date, provider, bucket, kind). Idempotent on conflict.
create table public.hmo_aging_snapshots (
  id              uuid primary key default gen_random_uuid(),
  snapshot_date   date not null,
  provider_id     uuid references public.hmo_providers(id) on delete set null,
  provider_name   text not null,
  bucket          text not null check (bucket in ('0-30', '31-60', '61-90', '91-180', '180+')),
  kind            text not null check (kind in ('lab', 'doctor')),
  total_php       numeric(14, 2) not null,
  item_count      int not null,
  recorded_by     uuid references public.staff_profiles(id),
  recorded_at     timestamptz not null default now(),
  constraint hmo_aging_snapshots_unique
    unique (snapshot_date, provider_id, bucket, kind)
);

create index idx_hmo_aging_snapshots_date on public.hmo_aging_snapshots (snapshot_date);
create index idx_hmo_aging_snapshots_provider on public.hmo_aging_snapshots (provider_id);

alter table public.hmo_aging_snapshots enable row level security;

create policy "hmo_aging_snapshots: admin read"
  on public.hmo_aging_snapshots
  for select to authenticated
  using (public.has_role(array['admin']));
