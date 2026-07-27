-- =============================================================================
-- 0128_discount_types.sql — Partner revisions PR G (item 5)
-- =============================================================================
-- Replaces the hardcoded discount vocabulary (visit form, create action, and
-- the test_requests.discount_kind CHECK from 0011) with an admin-managed
-- discount_types catalog.
--
--  * `code` is the stable key stored on test_requests.discount_kind. The five
--    legacy codes are seeded verbatim so existing rows keep referential
--    integrity and the accounting Sheets export (mappers.ts matches
--    senior_pwd_20 / pct_10 / pct_5 / other_pct_20 by code) is unaffected.
--  * Senior / PWD is statutory (RA 9994 / RA 10754): the row is seeded with
--    is_statutory = true and a guard trigger blocks any change to its rate,
--    code, or active flag — and blocks deleting it. Policy per the 2026-07-27
--    locked plan: fixed 20%, no per-service customization.
--  * `custom` stays as a built-in kind: the peso amount is typed at the
--    counter per line, so the row carries no percent/amount of its own.
--  * The CHECK on test_requests.discount_kind becomes a FK to
--    discount_types(code). Historical codes can never be deleted out from
--    under old rows (FK restricts), so the admin UI deactivates instead.
-- =============================================================================

create table public.discount_types (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  label        text not null,
  kind         text not null check (kind in ('percent', 'fixed', 'custom')),
  percent      numeric(5,2) check (percent is null or (percent > 0 and percent <= 100)),
  amount_php   numeric(10,2) check (amount_php is null or amount_php > 0),
  is_statutory boolean not null default false,
  active       boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Each kind carries exactly the fields it needs.
  constraint discount_types_kind_fields check (
    (kind = 'percent' and percent is not null and amount_php is null)
    or (kind = 'fixed' and amount_php is not null and percent is null)
    or (kind = 'custom' and percent is null and amount_php is null)
  )
);

create trigger trg_discount_types_updated_at
  before update on public.discount_types
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Statutory guard: the Senior/PWD row's rate is set by law, not by admins.
-- Deletes are blocked for statutory rows; updates may touch label/sort_order
-- only. Non-statutory rows can never be promoted to statutory from the app.
-- ---------------------------------------------------------------------------
create or replace function public.guard_statutory_discount()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_statutory then
      raise exception 'Senior/PWD is a statutory discount and cannot be deleted.'
        using errcode = 'P0047';
    end if;
    return old;
  end if;

  if old.is_statutory then
    if new.code is distinct from old.code
       or new.kind is distinct from old.kind
       or new.percent is distinct from old.percent
       or new.amount_php is distinct from old.amount_php
       or new.active is distinct from old.active
       or new.is_statutory is distinct from old.is_statutory then
      raise exception 'Senior/PWD is a statutory 20%% discount — its rate cannot be changed or disabled.'
        using errcode = 'P0047';
    end if;
  elsif new.is_statutory is distinct from old.is_statutory then
    raise exception 'Discounts cannot be marked statutory after creation.'
      using errcode = 'P0047';
  end if;

  return new;
end;
$$;

create trigger trg_discount_types_statutory_guard
  before update or delete on public.discount_types
  for each row execute function public.guard_statutory_discount();

-- At most ONE statutory row can ever exist. The seed below occupies the slot
-- and the guard trigger blocks deleting it, so a second statutory row (with a
-- made-up rate) can never be inserted — even via the REST API with an admin
-- session, which the insert RLS policy would otherwise allow.
create unique index discount_types_one_statutory_idx
  on public.discount_types(is_statutory)
  where is_statutory;

-- ---------------------------------------------------------------------------
-- RLS: all staff read (the new-visit form needs the active list); admin
-- writes. Patients never see this table — public pages compute the statutory
-- senior price from the flat 20% rate, not from here.
-- ---------------------------------------------------------------------------
alter table public.discount_types enable row level security;

create policy "discount_types: staff read"
  on public.discount_types for select
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

create policy "discount_types: admin insert"
  on public.discount_types for insert
  with check (public.has_role(array['admin']));

create policy "discount_types: admin update"
  on public.discount_types for update
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

create policy "discount_types: admin delete"
  on public.discount_types for delete
  using (public.has_role(array['admin']));

-- ---------------------------------------------------------------------------
-- Seed the legacy vocabulary. Codes must match the 0011 CHECK list exactly —
-- existing test_requests rows reference them the moment the FK lands below.
-- ---------------------------------------------------------------------------
insert into public.discount_types (code, label, kind, percent, amount_php, is_statutory, sort_order) values
  ('senior_pwd_20', 'Senior / PWD 20%',  'percent', 20,   null, true,  10),
  ('pct_10',        '10% off',           'percent', 10,   null, false, 20),
  ('pct_5',         '5% off',            'percent', 5,    null, false, 30),
  ('other_pct_20',  'Other 20% off',     'percent', 20,   null, false, 40),
  ('custom',        'Custom amount (₱)', 'custom',  null, null, false, 50)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Swap the hardcoded CHECK (0011, auto-named as the inline column check) for
-- a FK. Plain NO ACTION: renaming/deleting a code that history references
-- fails loudly instead of silently rewriting history.
-- ---------------------------------------------------------------------------
alter table public.test_requests
  drop constraint if exists test_requests_discount_kind_check;

alter table public.test_requests
  add constraint test_requests_discount_kind_fkey
  foreign key (discount_kind) references public.discount_types(code);

create index idx_test_requests_discount_kind
  on public.test_requests(discount_kind)
  where discount_kind is not null;
