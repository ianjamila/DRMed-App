-- 0107_patient_merges.sql
-- Ledger of merges so each can be reversed within an undo window. All access
-- via the service-role client (merge/undo actions, admin report); RLS enabled
-- with no policies => denied to anon/authenticated, service role bypasses.

create table if not exists public.patient_merges (
  id               uuid primary key default gen_random_uuid(),
  keep_id          uuid not null references public.patients(id),
  source_id        uuid not null references public.patients(id),
  merged_by        uuid references auth.users(id),
  merged_at        timestamptz not null default now(),
  moved            jsonb not null default '{}'::jsonb, -- { visits:[], appointments:[], audit_log:[], critical_alerts:[], patient_consents:[] }
  filled_from_source text[] not null default '{}',
  undone_at        timestamptz,
  undone_by        uuid references auth.users(id)
);

create index if not exists idx_patient_merges_active
  on public.patient_merges (merged_at desc) where undone_at is null;
create index if not exists idx_patient_merges_source
  on public.patient_merges (source_id);

alter table public.patient_merges enable row level security;
-- No policies on purpose: only the service-role client touches this table.
