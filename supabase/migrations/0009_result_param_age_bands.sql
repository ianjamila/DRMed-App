-- =============================================================================
-- 0009_result_param_age_bands.sql
-- =============================================================================
-- Phase 13 follow-up: per-parameter reference ranges that vary by age band
-- (Neonate / Infant / Pediatric / Adolescent / Adult) and optionally by sex
-- within a band.
--
-- Why: Phase 13's first cut only supports gender-specific ranges as duplicate
-- param rows (e.g. Hemoglobin F + Hemoglobin M). That doesn't cover paediatric
-- and neonatal medicine, where ranges shift dramatically with age — neonatal
-- haemoglobin is 14–24 g/dL vs. adult 12–16 (F) / 14–18 (M). For a clinic
-- that sees children, using adult thresholds would auto-flag normal newborns
-- as "L" and miss real abnormalities at the high end.
--
-- This migration is purely additive. result_template_params keeps its
-- ref_low_si/ref_high_si columns as the default. When this new table has
-- matching rows for a (parameter, patient age, patient sex) tuple, those
-- override the defaults at render and validation time.
-- =============================================================================

create table public.result_template_param_ranges (
  id              uuid primary key default gen_random_uuid(),
  parameter_id    uuid not null references public.result_template_params(id) on delete cascade,

  -- Half-open interval [age_min_months, age_max_months) in months.
  -- NULL on either side opens that end. Common bands (suggested but not enforced):
  --   neonate   : 0   – 1
  --   infant    : 1   – 24
  --   pediatric : 24  – 156   (2 y – 13 y)
  --   adolescent: 156 – 216   (13 y – 18 y)
  --   adult     : 216 – NULL
  age_min_months  int check (age_min_months is null or age_min_months >= 0),
  age_max_months  int check (age_max_months is null or age_max_months >= 0),
  constraint check_age_band_order
    check (age_max_months is null or age_min_months is null
           or age_max_months > age_min_months),

  -- Null = applies to either sex inside the age band. Use a non-null value
  -- when the range itself differs by sex (Hemoglobin in adolescents/adults).
  gender          text check (gender in ('F','M')),

  -- Admin-facing label rendered in the picker UI and in the medtech form
  -- (next to the displayed range) so a reader can verify which band fired.
  band_label      text not null,

  ref_low_si      numeric,
  ref_high_si     numeric,
  ref_low_conv    numeric,
  ref_high_conv   numeric,

  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_rtpr_param on public.result_template_param_ranges(parameter_id, sort_order);

create trigger trg_result_template_param_ranges_updated_at
  before update on public.result_template_param_ranges
  for each row execute function public.touch_updated_at();

alter table public.result_template_param_ranges enable row level security;

create policy "result_template_param_ranges: staff read"
  on public.result_template_param_ranges for select to authenticated
  using (public.has_role(array['reception','medtech','pathologist','admin']));

create policy "result_template_param_ranges: admin manage"
  on public.result_template_param_ranges for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));
