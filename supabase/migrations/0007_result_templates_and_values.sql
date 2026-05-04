-- =============================================================================
-- 0007_result_templates_and_values.sql
-- =============================================================================
-- Phase 13: structured result entry for in-house tests. The medtech enters
-- per-parameter values into a per-service template; the app generates the
-- result PDF server-side from those values + the medtech's signature.
-- Send-out tests (services.is_send_out=true) keep the existing PDF upload
-- path — those PDFs come from the partner lab and can't be regenerated.
--
-- See IMPLEMENTATION_PLAN.md "Phase 13" for the full design rationale,
-- security model, and the three template archetypes (simple / dual_unit /
-- multi_section / imaging_report) this schema must support.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- staff_profiles deltas: PRC license info that signs the printed PDF.
-- -----------------------------------------------------------------------------
alter table public.staff_profiles
  add column prc_license_no   text,
  add column prc_license_kind text
    check (prc_license_kind in ('RMT', 'MD', 'RT'));


-- -----------------------------------------------------------------------------
-- result_templates — one row per service that supports structured entry.
-- A service without a template falls back to PDF upload in the medtech UI.
-- -----------------------------------------------------------------------------
create table public.result_templates (
  id              uuid primary key default gen_random_uuid(),
  service_id      uuid not null unique references public.services(id) on delete cascade,
  layout          text not null check (layout in (
    'simple',          -- single-value list (CBC + Differential archetype)
    'dual_unit',       -- SI + Conventional columns side by side (Chemistry archetype)
    'multi_section',   -- grouped text+numeric+vocab rows (Urinalysis archetype)
    'imaging_report'   -- free-text Findings + Impression (X-Ray, Ultrasound)
  )),
  header_notes    text,
  footer_notes    text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_result_templates_service on public.result_templates(service_id);

create trigger trg_result_templates_touch_updated_at
  before update on public.result_templates
  for each row execute function public.touch_updated_at();


-- -----------------------------------------------------------------------------
-- result_template_params — the rows on the form (and the printed PDF).
-- -----------------------------------------------------------------------------
create table public.result_template_params (
  id                 uuid primary key default gen_random_uuid(),
  template_id        uuid not null references public.result_templates(id) on delete cascade,
  sort_order         int not null,
  section            text,
  is_section_header  boolean not null default false,
  parameter_name     text not null,
  input_type         text not null check (input_type in ('numeric', 'free_text', 'select')),
  -- Numeric-only fields. unit_si is required when input_type='numeric'; unit_conv
  -- is only set on dual_unit-layout templates.
  unit_si            text,
  unit_conv          text,
  ref_low_si         numeric,
  ref_high_si        numeric,
  ref_low_conv       numeric,
  ref_high_conv      numeric,
  -- gender override; null = applies to both. When a parameter has gender-
  -- specific ranges, two rows exist (one F, one M) with the same sort_order.
  gender             text check (gender in ('F', 'M')),
  -- For dual_unit layout only. Lets the form auto-fill the conventional column
  -- from the entered SI value (or vice versa).
  si_to_conv_factor  numeric,
  -- For input_type='select' (controlled vocabulary).
  allowed_values     text[],
  abnormal_values    text[],
  -- For input_type='free_text' — placeholder shown in the input box.
  placeholder        text,
  created_at         timestamptz not null default now()
);

create index idx_result_template_params_template
  on public.result_template_params(template_id, sort_order);


-- -----------------------------------------------------------------------------
-- Control-number sequence. Reception's existing forms run in the 6000-6900
-- range as of April 2026 (verified against the reference LAB RESULTS FORM
-- Sheet); start the sequence at 7000 to continue the run without collision.
-- -----------------------------------------------------------------------------
create sequence public.result_control_no_seq start with 7000 increment by 1;


-- -----------------------------------------------------------------------------
-- results deltas — control_no for the printed form, generation_kind so the
-- medtech UI knows which branch to render, and finalised_at to mark when the
-- structured entry was locked + the PDF generated.
-- -----------------------------------------------------------------------------
alter table public.results
  add column control_no       bigint unique default nextval('public.result_control_no_seq'),
  add column generation_kind  text not null default 'uploaded'
    check (generation_kind in ('uploaded', 'structured')),
  add column finalised_at     timestamptz;


-- -----------------------------------------------------------------------------
-- result_values — one row per non-header parameter when generation_kind is
-- 'structured'. Empty rows (`is_blank=true`) are still stored so the printed
-- PDF can render "—" without changing the visual layout from the reference.
-- -----------------------------------------------------------------------------
create table public.result_values (
  id                  uuid primary key default gen_random_uuid(),
  result_id           uuid not null references public.results(id) on delete cascade,
  parameter_id        uuid not null references public.result_template_params(id),
  numeric_value_si    numeric,
  numeric_value_conv  numeric,
  text_value          text,
  select_value        text,
  -- Computed by trigger from value vs ref range / abnormal_values; H/L/A or null.
  -- H = high (numeric > ref_high), L = low (numeric < ref_low), A = abnormal
  -- (controlled vocab in abnormal_values).
  flag                text check (flag in ('H', 'L', 'A')),
  is_blank            boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (result_id, parameter_id)
);

create index idx_result_values_result on public.result_values(result_id);

create trigger trg_result_values_touch_updated_at
  before update on public.result_values
  for each row execute function public.touch_updated_at();


-- -----------------------------------------------------------------------------
-- compute_result_flag — runs BEFORE INSERT/UPDATE on result_values; sets the
-- flag column based on the parent parameter's input_type and ref range.
--   numeric → 'H' if value > ref_high, 'L' if value < ref_low, else null
--   select  → 'A' if select_value ∈ abnormal_values, else null
--   free_text → null (admin can layer regex flags later)
-- For dual_unit numeric, SI is the source of truth; if only conv was entered,
-- it's converted via si_to_conv_factor before the comparison.
-- -----------------------------------------------------------------------------
create or replace function public.compute_result_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p record;
  v numeric;
begin
  select * into p
    from public.result_template_params
    where id = new.parameter_id;

  if p.input_type = 'numeric' then
    -- Prefer SI when present; otherwise back-convert from conv when we have
    -- the factor. Fall back to comparing conv against conv ranges.
    if new.numeric_value_si is not null then
      v := new.numeric_value_si;
      if v is null then new.flag := null;
      elsif p.ref_low_si  is not null and v < p.ref_low_si  then new.flag := 'L';
      elsif p.ref_high_si is not null and v > p.ref_high_si then new.flag := 'H';
      else new.flag := null;
      end if;
    elsif new.numeric_value_conv is not null then
      v := new.numeric_value_conv;
      if v is null then new.flag := null;
      elsif p.ref_low_conv  is not null and v < p.ref_low_conv  then new.flag := 'L';
      elsif p.ref_high_conv is not null and v > p.ref_high_conv then new.flag := 'H';
      else new.flag := null;
      end if;
    else
      new.flag := null;
    end if;
  elsif p.input_type = 'select' then
    if new.select_value is not null
       and p.abnormal_values is not null
       and new.select_value = any(p.abnormal_values) then
      new.flag := 'A';
    else
      new.flag := null;
    end if;
  else
    new.flag := null;
  end if;
  return new;
end;
$$;

create trigger trg_result_values_compute_flag
  before insert or update on public.result_values
  for each row execute function public.compute_result_flag();


-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.result_templates       enable row level security;
alter table public.result_template_params enable row level security;
alter table public.result_values          enable row level security;

-- Templates + params: any active staff role can read; only admin can mutate.
create policy "result_templates: staff read"
  on public.result_templates for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin']));
create policy "result_templates: admin manage"
  on public.result_templates for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

create policy "result_template_params: staff read"
  on public.result_template_params for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin']));
create policy "result_template_params: admin manage"
  on public.result_template_params for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

-- result_values: medtechs can write rows attached to test_requests they own
-- (assigned_to = auth.uid()) while the request is still editable
-- (status in 'in_progress' or 'result_uploaded'). Pathologist + admin can
-- always write. Reception cannot write at all.
create policy "result_values: medtech write own claimed test"
  on public.result_values for insert to authenticated
  with check (
    public.has_role(array['medtech', 'pathologist', 'admin'])
    and exists (
      select 1
      from public.results r
      join public.test_requests tr on tr.id = r.test_request_id
      where r.id = result_values.result_id
        and (
          public.has_role(array['pathologist', 'admin'])
          or (
            tr.assigned_to = auth.uid()
            and tr.status in ('in_progress', 'result_uploaded')
          )
        )
    )
  );

create policy "result_values: medtech update own claimed test"
  on public.result_values for update to authenticated
  using (
    public.has_role(array['medtech', 'pathologist', 'admin'])
    and exists (
      select 1
      from public.results r
      join public.test_requests tr on tr.id = r.test_request_id
      where r.id = result_values.result_id
        and (
          public.has_role(array['pathologist', 'admin'])
          or (
            tr.assigned_to = auth.uid()
            and tr.status in ('in_progress', 'result_uploaded')
          )
        )
    )
  )
  with check (
    public.has_role(array['medtech', 'pathologist', 'admin'])
    and exists (
      select 1
      from public.results r
      join public.test_requests tr on tr.id = r.test_request_id
      where r.id = result_values.result_id
        and (
          public.has_role(array['pathologist', 'admin'])
          or (
            tr.assigned_to = auth.uid()
            and tr.status in ('in_progress', 'result_uploaded')
          )
        )
    )
  );

-- Read: pathologist + admin see everything; medtechs see values they wrote
-- (i.e. attached to a test_request they were assigned). Reception does not
-- read raw values via the API — they download the rendered PDF via the
-- existing release flow.
create policy "result_values: read by owning medtech + pathologist + admin"
  on public.result_values for select to authenticated
  using (
    public.has_role(array['pathologist', 'admin'])
    or exists (
      select 1
      from public.results r
      join public.test_requests tr on tr.id = r.test_request_id
      where r.id = result_values.result_id
        and tr.assigned_to = auth.uid()
        and public.has_role(array['medtech'])
    )
  );

-- Delete: admin only. Once a value row exists, medtechs cannot wipe it from
-- under a pathologist; corrections happen via UPDATE.
create policy "result_values: admin delete"
  on public.result_values for delete to authenticated
  using (public.has_role(array['admin']));
