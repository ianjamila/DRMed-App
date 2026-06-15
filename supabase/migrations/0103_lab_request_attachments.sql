-- =============================================================================
-- 0103_lab_request_attachments.sql
-- =============================================================================
-- Lets a patient attach a photo/PDF of their doctor's lab-request form at
-- booking time (public /schedule + portal) instead of itemizing every test.
-- Files live in a private bucket; reception views them via short-lived signed
-- URLs minted by a service-role server action (no per-row storage RLS, same
-- pattern as the result-images bucket in 0038). The table is keyed by
-- appointments.booking_group_id (a shared, non-unique column — not a FK).
-- =============================================================================

-- Storage bucket: lab-request-forms ------------------------------------------
-- Accepts JPEG/PNG/WebP + HEIC/HEIF (iPhone) + PDF. 10 MB per-file cap.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lab-request-forms',
  'lab-request-forms',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
)
on conflict (id) do nothing;

-- Table: appointment_attachments --------------------------------------------
create table public.appointment_attachments (
  id                uuid primary key default gen_random_uuid(),
  booking_group_id  uuid not null,
  patient_id        uuid references public.patients(id) on delete set null,
  storage_path      text not null,
  filename          text not null,
  mime_type         text not null,
  size_bytes        int  not null,
  kind              text not null default 'lab_request',
  created_at        timestamptz not null default now(),
  constraint appointment_attachments_mime_allowlist
    check (mime_type in ('image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf')),
  constraint appointment_attachments_size_cap
    check (size_bytes > 0 and size_bytes <= 10485760)
);

create index idx_appt_attachments_group
  on public.appointment_attachments (booking_group_id);

-- RLS: active staff may read; writes are service-role only (no policy).
alter table public.appointment_attachments enable row level security;

create policy "appointment_attachments: staff read"
  on public.appointment_attachments for select to authenticated
  using (public.is_staff());
