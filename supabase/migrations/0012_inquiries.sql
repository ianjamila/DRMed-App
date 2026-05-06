-- =============================================================================
-- 0012_inquiries.sql
-- =============================================================================
-- Phase 10: Inquiry CRM. Captures inbound phone / FB / walk-up leads that
-- reception currently tracks in the "Inquiry log" tab of the live ops Sheet.
-- A pending inquiry can be promoted to a confirmed booking (linked_*_id set
-- when reception books from the inquiry detail page) or marked dropped with
-- a reason. Staff-only; admin-only delete.
-- =============================================================================

create table public.inquiries (
  id                     uuid primary key default gen_random_uuid(),
  caller_name            text not null check (length(trim(caller_name)) > 0),
  contact                text not null check (length(trim(contact)) > 0),
  channel                text not null
                           check (channel in ('phone', 'sms', 'walk_in', 'facebook', 'other')),
  service_interest       text,
  called_at              timestamptz not null default now(),
  received_by_id         uuid references auth.users(id) on delete set null,
  status                 text not null default 'pending'
                           check (status in ('pending', 'confirmed', 'dropped')),
  drop_reason            text,
  linked_appointment_id  uuid references public.appointments(id) on delete set null,
  linked_visit_id        uuid references public.visits(id) on delete set null,
  notes                  text,
  created_at             timestamptz not null default now(),
  created_by             uuid references auth.users(id) on delete set null,
  updated_at             timestamptz not null default now(),
  -- A confirmed inquiry must point at the booking that confirmed it; a
  -- dropped inquiry must give a reason so the CRM is auditable.
  constraint inquiries_status_consistency check (
    (status <> 'confirmed' or linked_appointment_id is not null or linked_visit_id is not null)
    and (status <> 'dropped' or (drop_reason is not null and length(trim(drop_reason)) > 0))
  )
);

create index idx_inquiries_status     on public.inquiries (status);
create index idx_inquiries_called_at  on public.inquiries (called_at desc);
create index idx_inquiries_received   on public.inquiries (received_by_id);

create trigger trg_inquiries_updated_at
  before update on public.inquiries
  for each row execute function public.touch_updated_at();

alter table public.inquiries enable row level security;

-- All staff can read (reception works with them daily, admin reviews them,
-- medtech/pathologist generally won't open the page but no harm in read).
create policy "inquiries: staff read"
  on public.inquiries
  for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin']));

-- Reception + admin create and edit inquiries.
create policy "inquiries: reception write"
  on public.inquiries
  for insert to authenticated
  with check (public.has_role(array['reception', 'admin']));

create policy "inquiries: reception update"
  on public.inquiries
  for update to authenticated
  using (public.has_role(array['reception', 'admin']))
  with check (public.has_role(array['reception', 'admin']));

-- Only admin can delete (treat inquiries as audit-bearing data).
create policy "inquiries: admin delete"
  on public.inquiries
  for delete to authenticated
  using (public.has_role(array['admin']));
