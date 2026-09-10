-- 0136_physician_compensation_table.sql
-- Moves each doctor's commercial terms off the public-read `physicians` table.
--
-- WHY
-- `physicians` is public by design — the website lists doctors, so `anon` holds
-- SELECT and the RLS policy "physicians: public read active" lets it through.
-- But a table grant covers EVERY column, and three of them are the doctor's
-- deal with the clinic. Measured on prod 2026-09-10 as role anon: 20 rows, with
-- compensation_arrangement populated 20/20 (3 distinct arrangements) and
-- clinic_cut_php 20/20. Each doctor's revenue split, readable by anyone holding
-- the publishable key, and by any patient-portal login.
--
-- WHY NOT A COLUMN-LEVEL REVOKE
-- Because it does nothing. In PostgreSQL a TABLE-level SELECT grant confers the
-- privilege on every column, and a column-level REVOKE cannot subtract from it.
-- `revoke select (compensation_arrangement, …) on physicians from anon` applies
-- cleanly, reports success, and leaves has_column_privilege() still true —
-- verified on prod before this migration was written. The two shapes that do
-- work are (a) revoke the table grant then grant back the safe columns, which
-- makes every column added later invisible to anon until someone remembers a
-- grant, or (b) this: move the columns somewhere anon was never granted.
-- Deny by default beats a list nobody maintains.
--
-- WHAT MOVES
--   compensation_arrangement      not null, default 'pf_split', 3-value CHECK
--   clinic_cut_php                numeric(10,2), null = fall back to arrangement
--   default_consultation_fee_php  numeric(10,2), null = form stays blank
-- All three keep their exact types, defaults and CHECK constraints (0129).
--
-- DEPENDENCIES THAT MUST MOVE WITH THEM — note pg_depend does NOT list the
-- function; function bodies resolve at runtime, so a catalog dependency query
-- finds only the view. Both were found by reading the tree.
--   v_ops_daily_doctor (0093, last redefined 0129) selects ph.compensation_
--     arrangement and ph.clinic_cut_php. Recreated below, restating
--     `security_invoker = on` — CREATE OR REPLACE VIEW's WITH clause REPLACES
--     the options, so omitting it would silently revert the view to definer
--     rights (the trap 0135 documents). This migration also ADDS the view to
--     the HARDENED map in src/lib/supabase/hardened-views.test.ts, which until
--     now covered only the 0134/0135 views — so a future recreation that drops
--     the clause fails the build instead of shipping quietly.
--   recompute_clinic_fee_for_unreleased() (0065 → 0066 → 0129) joins physicians
--     for both columns. Recreated below against the new table.
--
-- The `services` send-out columns have the same exposure and are deliberately
-- NOT in this migration: bridge_test_request_released() does `select * into
-- v_service from services` on the release hot path and posts COGS from those
-- columns, so that move is its own change with its own review.

-- ---------------------------------------------------------------------------
-- 1. The side table
-- ---------------------------------------------------------------------------
create table public.physician_compensation (
  physician_id uuid primary key
    references public.physicians(id) on delete cascade,
  compensation_arrangement text not null default 'pf_split'
    check (compensation_arrangement in ('pf_split', 'rent_paying', 'shareholder')),
  clinic_cut_php numeric(10,2)
    check (clinic_cut_php is null or clinic_cut_php >= 0),
  default_consultation_fee_php numeric(10,2)
    check (default_consultation_fee_php is null or default_consultation_fee_php >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.physician_compensation is
  'Per-doctor commercial terms, split out of physicians in 0136 because that table is public-read (the website lists doctors) and a table grant covers every column. Admin-only: no anon grant, no staff-read policy. See src/lib/visits/consultation-fee.ts for how the values are applied.';
comment on column public.physician_compensation.clinic_cut_php is
  'Per-doctor override of the clinic''s cut of a consult/procedure fee. NULL = fall back to the arrangement default (₱100 for pf_split, ₱0 for rent_paying/shareholder).';
comment on column public.physician_compensation.default_consultation_fee_php is
  'Per-doctor default consultation fee, prefills the consult fee input on new visits. NULL = no default (the form stays blank).';

-- Every physician gets a row, so a reader never has to distinguish "no row"
-- from "no override" — the arrangement default lives in the column default.
insert into public.physician_compensation
  (physician_id, compensation_arrangement, clinic_cut_php, default_consultation_fee_php)
select id, compensation_arrangement, clinic_cut_php, default_consultation_fee_php
from public.physicians;

-- Keep that invariant for doctors added later.
create or replace function public.fn_physician_compensation_row()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.physician_compensation (physician_id)
  values (new.id)
  on conflict (physician_id) do nothing;
  return new;
end;
$$;

create trigger trg_physicians_compensation_row
  after insert on public.physicians
  for each row execute function public.fn_physician_compensation_row();

alter table public.physician_compensation enable row level security;

-- Admin only. Deliberately NO "staff read" policy and no anon grant: the whole
-- point of the move is that these values leave the public-read surface. Every
-- reader in src/ goes through createAdminClient() (service_role), which
-- bypasses RLS — verified call site by call site before this migration.
create policy "physician_compensation: admin manage"
  on public.physician_compensation for all to authenticated
  using (has_role(array['admin']))
  with check (has_role(array['admin']));

revoke all on public.physician_compensation from anon;

-- ---------------------------------------------------------------------------
-- 2. Dependants, repointed at the new table
-- ---------------------------------------------------------------------------
create or replace view public.v_ops_daily_doctor
with (security_invoker = on) as
select
  (tr.released_at at time zone 'Asia/Manila')::date as business_date,
  ph.id   as physician_id,
  ph.full_name,
  ph.specialty,
  pc.compensation_arrangement,
  count(*)                                          as consult_count,
  coalesce(sum(tr.base_price_php), 0::numeric)::numeric(14,2) as sales_gross,
  coalesce(sum(tr.doctor_pf_php), 0::numeric)::numeric(14,2)  as pf_collected,
  pc.clinic_cut_php
from test_requests tr
  join services s on s.id = tr.service_id
  join visits v on v.id = tr.visit_id
  left join physicians ph on ph.id = v.attending_physician_id
  left join physician_compensation pc on pc.physician_id = ph.id
where tr.status = 'released' and s.kind = 'doctor_consultation'
group by ((tr.released_at at time zone 'Asia/Manila')::date),
         ph.id, ph.full_name, ph.specialty,
         pc.compensation_arrangement, pc.clinic_cut_php;

create or replace function public.recompute_clinic_fee_for_unreleased()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_affected int;
begin
  with target_ids as (
    select tr.id
    from public.test_requests tr
    join public.visits v on v.id = tr.visit_id
    left join public.physicians p
      on p.id = coalesce(tr.attending_physician_id, v.attending_physician_id)
    left join public.physician_compensation pc on pc.physician_id = p.id
    where coalesce(
            pc.clinic_cut_php,
            case when pc.compensation_arrangement in ('rent_paying', 'shareholder') then 0 else 100 end
          ) = 0
      and tr.clinic_fee_php > 0
      and not exists (
        select 1 from public.journal_entries je
        where je.source_kind = 'test_request'
          and je.source_id = tr.id
          and je.status = 'posted'
      )
  ),
  updated as (
    update public.test_requests tr2
      set clinic_fee_php = 0,
          doctor_pf_php = tr2.final_price_php
      where tr2.id in (select id from target_ids)
      returning tr2.id
  )
  select count(*) into v_affected from updated;

  return jsonb_build_object('rows_affected', v_affected);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Drop the originals — this is what actually closes the exposure
-- ---------------------------------------------------------------------------
alter table public.physicians
  drop column compensation_arrangement,
  drop column clinic_cut_php,
  drop column default_consultation_fee_php;
