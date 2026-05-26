-- =============================================================================
-- 0073_inventory.sql
-- =============================================================================
-- Lab inventory v1. Two tables (items + movements) and one view for current
-- balances. No GL bridge yet — receive/issue movements don't post JEs in
-- this version. Cost accounting against the lab-supplies expense account
-- stays driven by AP bills (12.4) for now; this module is operational
-- (stock counting + expiry tracking) rather than financial.
-- =============================================================================

create table public.inventory_items (
  id                  uuid primary key default gen_random_uuid(),
  code                text,
  name                text not null,
  -- Section is freeform here (not the ServiceSection enum) so admin can
  -- bucket front-desk supplies separately from lab reagents.
  section             text,
  unit                text not null default 'pcs',
  reorder_threshold   numeric(12,2) not null default 0 check (reorder_threshold >= 0),
  expiry_tracking     boolean not null default false,
  vendor_id           uuid references public.vendors(id),
  notes               text,
  is_active           boolean not null default true,
  created_by          uuid references public.staff_profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index idx_inventory_items_section
  on public.inventory_items(section)
  where is_active = true;
create index idx_inventory_items_active_name
  on public.inventory_items(name)
  where is_active = true;

create trigger trg_inventory_items_updated_at
  before update on public.inventory_items
  for each row execute function public.touch_updated_at();

create table public.inventory_movements (
  id              uuid primary key default gen_random_uuid(),
  item_id         uuid not null references public.inventory_items(id) on delete cascade,
  movement_type   text not null
                    check (movement_type in ('receive', 'issue', 'adjust', 'expire', 'count')),
  -- Signed: positive for receive / adjust-up, negative for issue / expire /
  -- adjust-down. 'count' is also signed (delta from prior count).
  quantity        numeric(12,2) not null check (quantity <> 0),
  unit_cost_php   numeric(12,2),
  expiry_date     date,
  lot_number      text,
  reference       text,
  notes           text,
  created_by      uuid references public.staff_profiles(id),
  created_at      timestamptz not null default now()
);

create index idx_inventory_movements_item
  on public.inventory_movements(item_id, created_at desc);
create index idx_inventory_movements_expiry
  on public.inventory_movements(expiry_date)
  where expiry_date is not null;

-- Aggregate view: current balance + expiring-soonest lot per item.
create or replace view public.v_inventory_balances as
select
  i.id                              as item_id,
  i.code,
  i.name,
  i.section,
  i.unit,
  i.reorder_threshold,
  i.expiry_tracking,
  i.is_active,
  coalesce(sum(m.quantity), 0)      as on_hand,
  case
    when coalesce(sum(m.quantity), 0) <= 0 then 'out_of_stock'
    when coalesce(sum(m.quantity), 0) < i.reorder_threshold then 'low'
    else 'ok'
  end                               as stock_status,
  -- Earliest non-passed expiry across receive movements still contributing
  -- to positive on-hand. Cheap heuristic; we don't model lot-level deduction
  -- in v1, so this is a "next expiry to worry about" indicator, not a
  -- strict per-lot remaining figure.
  (
    select min(expiry_date)
      from public.inventory_movements im2
     where im2.item_id = i.id
       and im2.movement_type = 'receive'
       and im2.expiry_date is not null
       and im2.expiry_date >= current_date
  )                                 as next_expiry
from public.inventory_items i
left join public.inventory_movements m on m.item_id = i.id
group by i.id;

alter table public.inventory_items     enable row level security;
alter table public.inventory_movements enable row level security;

create policy "inventory_items: staff read"
  on public.inventory_items
  for select to authenticated
  using (public.is_staff());

create policy "inventory_items: admin write"
  on public.inventory_items
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

create policy "inventory_movements: staff read"
  on public.inventory_movements
  for select to authenticated
  using (public.is_staff());

create policy "inventory_movements: lab + admin write"
  on public.inventory_movements
  for all to authenticated
  using (public.has_role(array['admin', 'medtech', 'xray_technician']))
  with check (public.has_role(array['admin', 'medtech', 'xray_technician']));
