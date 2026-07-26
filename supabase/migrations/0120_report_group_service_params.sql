-- =============================================================================
-- 0120 — report_group_service_params
-- =============================================================================
-- Moves the consolidated encoding form's hardcoded SERVICE_TO_PARAMS map
-- (consolidated-form.tsx) into the database. One row = "ordering this service
-- enables this template parameter on the consolidated form". Linking by
-- parameter_id (not name) means renaming a parameter in the admin editor can
-- no longer silently disable a medtech field.
--
-- LIPID_PROFILE_PACKAGE deliberately gets NO rows: it is a lab_package billing
-- header (0040) whose ₀-priced component test_requests (CHOLESTEROL,
-- HDL_LDL_VLDL, TRIGLYCERIDES) carry the encoding. See the 2026-07-27 spec.
-- =============================================================================

create table public.report_group_service_params (
  service_id   uuid not null references public.services(id) on delete cascade,
  parameter_id uuid not null references public.result_template_params(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (service_id, parameter_id)
);

create index idx_rgsp_parameter
  on public.report_group_service_params(parameter_id);

alter table public.report_group_service_params enable row level security;

-- Same shape as package_components (0040). Medtech read is load-bearing: the
-- consolidated queue page reads this through the user-scoped client.
create policy "report_group_service_params: staff read"
  on public.report_group_service_params for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

create policy "report_group_service_params: admin write"
  on public.report_group_service_params for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

-- ----- Backfill from the hardcoded map ---------------------------------------
-- Joining on parameter_name naturally expands Creatinine and Uric Acid to both
-- their gendered rows (F + M), matching today's name-based behaviour exactly.
with map(code, pname) as (
  values
    ('FBS_RBS',       'FBS'),
    ('BUN',           'BUN'),
    ('CREATININE',    'Creatinine'),
    ('BUA_URIC_ACID', 'Uric Acid'),
    ('TRIGLYCERIDES', 'Triglycerides'),
    ('CHOLESTEROL',   'Cholesterol'),
    ('HDL_LDL_VLDL',  'HDL'),
    ('HDL_LDL_VLDL',  'LDL'),
    ('HDL_LDL_VLDL',  'VLDL'),
    ('SGPT_ALT',      'SGPT (ALT)'),
    ('SGOT_AST',      'SGOT (AST)'),
    ('HBA1C',         'HBA1C'),
    ('LIPID_PROFILE', 'Triglycerides'),
    ('LIPID_PROFILE', 'Cholesterol'),
    ('LIPID_PROFILE', 'HDL'),
    ('LIPID_PROFILE', 'LDL'),
    ('LIPID_PROFILE', 'VLDL')
)
insert into public.report_group_service_params (service_id, parameter_id)
select s.id, p.id
  from map m
  join public.services s
    on s.code = m.code and s.report_group_id is not null
  join public.result_templates rt
    on rt.report_group_id = s.report_group_id and rt.service_id is null
  join public.result_template_params p
    on p.template_id = rt.id and p.parameter_name = m.pname
on conflict do nothing;

-- ----- Assert ----------------------------------------------------------------
-- 17 map entries; CREATININE and BUA_URIC_ACID each expand to 2 gendered rows
-- => 19 pairs. On a fresh-from-migrations database `services` is empty (it is
-- seeded by scripts, not migrations), so the join legitimately inserts 0 rows —
-- only assert when grouped services actually exist.
do $$
declare
  svc_count  int;
  pair_count int;
begin
  select count(*) into svc_count
    from public.services where report_group_id is not null;
  select count(*) into pair_count
    from public.report_group_service_params;
  if svc_count > 0 and pair_count <> 19 then
    raise exception
      'report_group_service_params backfill expected 19 rows, got % (grouped services: %)',
      pair_count, svc_count;
  end if;
end $$;
