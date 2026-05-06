-- =============================================================================
-- 0013_gift_codes.sql
-- =============================================================================
-- Phase 11: Gift codes / vouchers. Reception currently tracks pre-issued
-- codes (e.g. GC-EM6J-SB8K-TSJA, ₱500) in a Sheet — generation, purchase,
-- and redemption all live there. This migration moves them into the app
-- with explicit status transitions and audit-bearing FKs to the actual
-- visit they were redeemed against.
--
-- Lifecycle: generated → purchased → redeemed
--           (cancelled is a terminal state for misprints / voids)
-- Codes are whole-use only — applying a ₱500 code to a ₱300 visit forfeits
-- the ₱200 balance, like a paper voucher.
-- =============================================================================

create table public.gift_codes (
  id                       uuid primary key default gen_random_uuid(),
  code                     text not null unique
                             check (code ~ '^GC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  face_value_php           numeric(10,2) not null check (face_value_php > 0),
  status                   text not null default 'generated'
                             check (status in ('generated', 'purchased', 'redeemed', 'cancelled')),

  -- Generation: who minted the code and as part of which batch.
  generated_at             timestamptz not null default now(),
  generated_by             uuid references auth.users(id) on delete set null,
  batch_label              text,

  -- Purchase: when reception sold the code to someone.
  purchased_at             timestamptz,
  purchased_by_name        text,
  purchased_by_contact     text,
  purchase_payment_id      uuid references public.payments(id) on delete set null,
  sold_by                  uuid references auth.users(id) on delete set null,

  -- Redemption: applied as a payment on a real visit.
  redeemed_at              timestamptz,
  redeemed_by              uuid references auth.users(id) on delete set null,
  redeemed_visit_id        uuid references public.visits(id) on delete restrict,
  redeemed_payment_id      uuid references public.payments(id) on delete set null,

  -- Cancellation: misprint, voided, etc.
  cancelled_at             timestamptz,
  cancelled_by             uuid references auth.users(id) on delete set null,
  cancellation_reason      text,

  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint gift_codes_status_consistency check (
    (status <> 'purchased' or purchased_at is not null)
    and (status <> 'redeemed' or (redeemed_at is not null and redeemed_visit_id is not null))
    and (status <> 'cancelled' or (cancelled_at is not null and cancellation_reason is not null and length(trim(cancellation_reason)) > 0))
  )
);

create index idx_gift_codes_status         on public.gift_codes (status);
create index idx_gift_codes_generated_at   on public.gift_codes (generated_at desc);
create index idx_gift_codes_batch_label    on public.gift_codes (batch_label);
create index idx_gift_codes_redeemed_visit on public.gift_codes (redeemed_visit_id);

create trigger trg_gift_codes_updated_at
  before update on public.gift_codes
  for each row execute function public.touch_updated_at();

alter table public.gift_codes enable row level security;

-- All staff can read so reception can search by code at the counter and
-- admin can audit. Reception writes for purchase + redemption transitions;
-- admin can do anything (generate batches, cancel, edit metadata).
create policy "gift_codes: staff read"
  on public.gift_codes
  for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin']));

create policy "gift_codes: admin write"
  on public.gift_codes
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

-- Reception can transition codes through purchase + redemption (and reverse
-- a misclick within the same shift), but not generate or cancel — those
-- stay admin-only via the admin write policy above.
create policy "gift_codes: reception update"
  on public.gift_codes
  for update to authenticated
  using (public.has_role(array['reception']))
  with check (public.has_role(array['reception']));
