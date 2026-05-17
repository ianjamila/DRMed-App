-- =============================================================================
-- 0040 — Package decomposition
-- =============================================================================
-- Adds the schema for lab_package services to fan out into a billing header
-- test_request + N component test_requests at order time. The header carries
-- the package price and HMO/discount metadata; components are ₱0 rows with
-- real templates that route to medtech / xray_technologist via service.section.
--
-- See docs/superpowers/specs/2026-05-17-14-package-decomposition-design.md
-- for the full design rationale.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- package_components — defines which services compose each package.
-- ---------------------------------------------------------------------------
create table public.package_components (
  package_service_id   uuid not null references public.services(id) on delete cascade,
  component_service_id uuid not null references public.services(id) on delete restrict,
  sort_order           int  not null default 0,
  created_at           timestamptz not null default now(),
  primary key (package_service_id, component_service_id),
  constraint package_components_no_self_ref check (package_service_id <> component_service_id)
);

create index idx_package_components_pkg
  on public.package_components(package_service_id, sort_order);

alter table public.package_components enable row level security;

-- Reads: any authenticated staff (read-only config).
create policy "package_components: staff read"
  on public.package_components for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

-- Writes: admin only (composition is a config decision).
create policy "package_components: admin write"
  on public.package_components for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));


-- ---------------------------------------------------------------------------
-- test_requests: parent_id + is_package_header + package_completed_at
-- ---------------------------------------------------------------------------
alter table public.test_requests
  add column parent_id            uuid references public.test_requests(id) on delete cascade,
  add column is_package_header    boolean not null default false,
  add column package_completed_at timestamptz;

-- A header cannot have a parent; a component cannot itself be a header.
alter table public.test_requests
  add constraint test_requests_parent_shape_check check (
    (parent_id is null)
    or
    (parent_id is not null and is_package_header = false)
  );

create index idx_test_requests_parent
  on public.test_requests(parent_id)
  where parent_id is not null;

create index idx_test_requests_pkg_header
  on public.test_requests(visit_id)
  where is_package_header = true;

create index idx_test_requests_completed
  on public.test_requests(package_completed_at)
  where package_completed_at is not null;


-- ---------------------------------------------------------------------------
-- Trigger: parent_id must reference a row with is_package_header = true.
-- Defends against app-layer bugs (chained components, child of standalone).
-- ---------------------------------------------------------------------------
create or replace function public.fn_test_request_parent_is_header()
returns trigger language plpgsql as $$
declare
  v_parent_is_header boolean;
begin
  if new.parent_id is null then
    return new;
  end if;
  select is_package_header into v_parent_is_header
    from public.test_requests
    where id = new.parent_id;
  if v_parent_is_header is null then
    raise exception 'parent_id % does not exist', new.parent_id;
  end if;
  if v_parent_is_header = false then
    raise exception 'parent_id % must reference an is_package_header=true row',
      new.parent_id;
  end if;
  return new;
end;
$$;

create trigger tg_test_request_parent_is_header
  before insert or update of parent_id on public.test_requests
  for each row execute function public.fn_test_request_parent_is_header();


-- ---------------------------------------------------------------------------
-- Trigger: header rows auto-promote from 'in_progress' to 'ready_for_release'
-- on insert. No work to claim → no need to sit in any queue waiting.
-- The existing 12.2 payment-gating trigger then advances to 'released' when
-- the visit is paid.
-- ---------------------------------------------------------------------------
create or replace function public.fn_header_auto_promote()
returns trigger language plpgsql as $$
begin
  if new.is_package_header = true and new.status = 'in_progress' then
    new.status := 'ready_for_release';
  end if;
  return new;
end;
$$;

create trigger tg_header_auto_promote
  before insert on public.test_requests
  for each row execute function public.fn_header_auto_promote();


-- ---------------------------------------------------------------------------
-- Trigger: set package_completed_at on the header when the last non-terminal
-- component reaches a terminal state ('released' or 'cancelled').
-- Cancelled components count as terminal — otherwise a partial-cancellation
-- package would never complete. The IS NULL guard means amendments do not
-- re-stamp the timestamp. The status='released' guard prevents cascade-
-- cancellation from setting a misleading completion timestamp on a cancelled
-- package.
-- ---------------------------------------------------------------------------
create or replace function public.fn_set_package_completed_at()
returns trigger language plpgsql as $$
declare
  v_pending int;
begin
  if new.parent_id is null then return new; end if;
  if new.status not in ('released', 'cancelled') then return new; end if;
  if old.status = new.status then return new; end if;

  select count(*) into v_pending
    from public.test_requests
    where parent_id = new.parent_id
      and status not in ('released', 'cancelled')
      and id <> new.id;

  if v_pending = 0 then
    update public.test_requests
      set package_completed_at = now()
      where id = new.parent_id
        and package_completed_at is null
        and status = 'released';
  end if;
  return new;
end;
$$;

create trigger tg_set_package_completed_at
  after update of status on public.test_requests
  for each row execute function public.fn_set_package_completed_at();


-- ---------------------------------------------------------------------------
-- Trigger: when a header is cancelled, cascade 'cancelled' to all
-- non-released non-cancelled components. Released components keep their
-- state — clinical record stands even if the package was retroactively
-- cancelled.
-- ---------------------------------------------------------------------------
create or replace function public.fn_cascade_cancel_components()
returns trigger language plpgsql as $$
begin
  if new.is_package_header = false then return new; end if;
  if new.status <> 'cancelled' then return new; end if;
  if old.status = 'cancelled' then return new; end if;

  update public.test_requests
    set status = 'cancelled',
        cancelled_reason = coalesce(cancelled_reason, 'package header cancelled')
    where parent_id = new.id
      and status not in ('released', 'cancelled');
  return new;
end;
$$;

create trigger tg_cascade_cancel_components
  after update of status on public.test_requests
  for each row execute function public.fn_cascade_cancel_components();
