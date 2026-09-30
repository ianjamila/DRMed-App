-- 0203_ad_spend_leads_bookings.sql
--
-- Phase 4 of the Sheet Sync follow-ups: the Ad Performance screen reads its
-- rows from the database (shared by every admin, on any browser) instead of one
-- browser's localStorage. For that the database must keep everything the screen
-- shows, so ad_spend_daily gains the ad file's leads, the platform-reported
-- bookings and the ad's display name.
--
-- Additive: three nullable columns (NULL = the file did not say; an explicit 0
-- is kept), a re-created ad_spend_import (the 0193 body + the three new fields,
-- every other rule unchanged: same-kind partial uploads update only the ads
-- they mention, a kind change replaces only when nothing was rejected, mixed
-- kinds are refused, one advisory lock, one audit row) and a new admin-gated
-- reader, ad_spend_rows.
--
-- Nothing else changes: ad_spend_daily_totals / ad_spend_coverage /
-- ad_spend_delete (Patient Sources "Cost per new patient") are untouched.

alter table public.ad_spend_daily
  add column if not exists leads int check (leads is null or leads >= 0),
  add column if not exists platform_bookings int check (platform_bookings is null or platform_bookings >= 0),
  add column if not exists ad_label text check (ad_label is null or char_length(ad_label) <= 300);

comment on column public.ad_spend_daily.leads is
  'Leads / results / conversations the ad platform reported for this ad and day. NULL = the file did not say (unknown); 0 = reported as zero.';
comment on column public.ad_spend_daily.platform_bookings is
  'Bookings / conversions the ad platform reported (NOT the clinic''s own appointments). NULL = unknown; 0 = reported as zero.';
comment on column public.ad_spend_daily.ad_label is
  'The ad''s display name exactly as uploaded (ad_key is its normalised form or id:<ad id>). NULL for a campaign-total row or when the file had no ad name.';

-- Ad_spend_import: 0193's body, with ad_label / leads / platform_bookings
-- carried through the recordsets, the duplicate-key sum and the upsert.
-- (3-arg signature unchanged, so CREATE OR REPLACE keeps its grants; they are
-- restated below anyway.)
create or replace function public.ad_spend_import(p_upload_id uuid, p_rows jsonb, p_rejected_count int default 0)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted int := 0;
  v_replaced int := 0;
  v_deleted int := 0;
  v_days int := 0;
  v_n int;
  v_kind_changed boolean;
begin
  if not public.has_role(array['admin']) then
    raise exception 'Only admins can save ad spend' using errcode = '42501';
  end if;
  -- Codex recheck #3: serialize every import/removal so two concurrent
  -- uploads can never both observe an empty/stale group and both insert.
  perform pg_advisory_xact_lock(hashtext('ad_spend_import'));

  if p_upload_id is null or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Ad spend import needs an upload id and a list of rows' using errcode = '22023';
  end if;
  if p_rejected_count is null or p_rejected_count < 0 then
    raise exception 'Ad spend import needs a non-negative rejected row count' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_rows);
  if v_n = 0 or v_n > 20000 then
    raise exception 'Ad spend import takes 1 to 20,000 rows, got %', v_n using errcode = '22023';
  end if;

  -- (P5) One group (spend_date, platform, campaign_key) must carry ONE kind of
  -- row. The client parser guarantees it, but a direct RPC call mixing a
  -- campaign total with per-ad rows would otherwise keep both (min(kind) below
  -- picks one, and the delete leaves the rest): double counted spend. Refuse
  -- before anything is deleted or written.
  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as r(
      spend_date date, platform text, campaign_key text, ad_key text,
      campaign_label text, spend_php numeric, impressions int, clicks int,
      ad_label text, leads int, platform_bookings int)
    group by r.spend_date, r.platform, r.campaign_key
    having count(distinct case when r.ad_key = '(campaign)' then 'total'
                               when r.ad_key like 'id:%' then 'id'
                               else 'name' end) > 1
  ) then
    raise exception 'A campaign and day in this file carries more than one ad-spend breakdown (campaign total, per ad name, per ad ID). Nothing was saved. [mixed breakdown]'
      using errcode = '22023';
  end if;

  -- A row's KIND: "(campaign)" is a campaign total; "id:…" is a per-ad row
  -- keyed by ad ID; anything else is a per-ad row keyed by ad name (the
  -- parser refuses a file mixing more than one kind for the same group, so a
  -- touched group's uploaded rows are homogeneous in practice). If any
  -- touched group's kind differs from what is already saved for it — a
  -- representation change — and the file had rejected rows, refuse the
  -- whole upload: nothing is saved.
  select exists (
    select 1
    from (
      select r.spend_date, r.platform, r.campaign_key,
             min(case when r.ad_key = '(campaign)' then 'total'
                      when r.ad_key like 'id:%' then 'id'
                      else 'name' end) as kind
      from jsonb_to_recordset(p_rows) as r(
        spend_date date, platform text, campaign_key text, ad_key text,
        campaign_label text, spend_php numeric, impressions int, clicks int,
      ad_label text, leads int, platform_bookings int)
      group by r.spend_date, r.platform, r.campaign_key
    ) g
    where exists (
      select 1 from public.ad_spend_daily a
      where a.spend_date = g.spend_date and a.platform = g.platform and a.campaign_key = g.campaign_key
        and (case when a.ad_key = '(campaign)' then 'total'
                  when a.ad_key like 'id:%' then 'id'
                  else 'name' end) <> g.kind
    )
  ) into v_kind_changed;

  if v_kind_changed and p_rejected_count > 0 then
    -- [breakdown change] tags this specific message for the action to map to
    -- clean user text (never raw PG text) — never confuse it with any other
    -- 22023 raised above.
    raise exception 'This file changes how saved spend is broken down (campaign total vs per ad) but % rows were rejected — fix them and upload again. Nothing was saved. [breakdown change]', p_rejected_count
      using errcode = '22023';
  end if;

  -- Delete only rows of a DIFFERENT kind within each touched group. A
  -- same-kind row is left alone here — ON CONFLICT below updates it in
  -- place — so a sibling ad_key the upload doesn't mention survives. Two
  -- separate statements (not one WITH with two data-modifying CTEs on the
  -- same table, whose relative order is unspecified) so this delete is
  -- guaranteed visible to the insert that follows it.
  delete from public.ad_spend_daily a
  using (
    select r.spend_date, r.platform, r.campaign_key,
           min(case when r.ad_key = '(campaign)' then 'total'
                    when r.ad_key like 'id:%' then 'id'
                    else 'name' end) as kind
    from jsonb_to_recordset(p_rows) as r(
      spend_date date, platform text, campaign_key text, ad_key text,
      campaign_label text, spend_php numeric, impressions int, clicks int,
      ad_label text, leads int, platform_bookings int)
    group by r.spend_date, r.platform, r.campaign_key
  ) g
  where a.spend_date = g.spend_date and a.platform = g.platform and a.campaign_key = g.campaign_key
    and (case when a.ad_key = '(campaign)' then 'total'
              when a.ad_key like 'id:%' then 'id'
              else 'name' end) <> g.kind;
  get diagnostics v_deleted = row_count;

  with src as (
    select r.spend_date, r.platform, r.campaign_key, r.ad_key,
           max(r.campaign_label) as campaign_label,
           sum(r.spend_php) as spend_php,
           sum(r.impressions)::int as impressions,
           sum(r.clicks)::int as clicks,
           max(r.ad_label) as ad_label,
           sum(r.leads)::int as leads,
           sum(r.platform_bookings)::int as platform_bookings
    from jsonb_to_recordset(p_rows) as r(
      spend_date date, platform text, campaign_key text, ad_key text,
      campaign_label text, spend_php numeric, impressions int, clicks int,
      ad_label text, leads int, platform_bookings int)
    group by r.spend_date, r.platform, r.campaign_key, r.ad_key
  ),
  up as (
    insert into public.ad_spend_daily as a
      (spend_date, platform, campaign_key, ad_key, campaign_label, spend_php,
       impressions, clicks, ad_label, leads, platform_bookings, uploaded_by, uploaded_at, upload_id)
    select s.spend_date, s.platform, s.campaign_key, s.ad_key, s.campaign_label, s.spend_php,
           s.impressions, s.clicks, s.ad_label, s.leads, s.platform_bookings, auth.uid(), now(), p_upload_id
    from src s
    on conflict (spend_date, platform, campaign_key, ad_key) do update
      set campaign_label = excluded.campaign_label,
          spend_php      = excluded.spend_php,
          impressions    = excluded.impressions,
          clicks         = excluded.clicks,
          ad_label       = excluded.ad_label,
          leads          = excluded.leads,
          platform_bookings = excluded.platform_bookings,
          uploaded_by    = excluded.uploaded_by,
          uploaded_at    = excluded.uploaded_at,
          upload_id      = excluded.upload_id
    returning (xmax = 0) as inserted, a.spend_date
  )
  select count(*) filter (where u.inserted), count(*) filter (where not u.inserted), count(distinct u.spend_date)
    into v_inserted, v_replaced, v_days
  from up u;
  v_replaced := v_replaced + v_deleted;

  insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (auth.uid(), 'staff', 'ad_spend.imported', 'ad_spend_upload', p_upload_id,
          jsonb_build_object('inserted', v_inserted, 'replaced', v_replaced, 'days', v_days));

  return jsonb_build_object('inserted', v_inserted, 'replaced', v_replaced, 'days', v_days);
end;
$$;

-- Per-ad rows for the Ad Performance screen. Admin-gated like the other
-- ad_spend_* readers (has_role follows View-as, 0182, so a reception View-as
-- session is refused). Period: at most 400 days, start on or before end. It does
-- NOT reuse _ps_check_period: that helper's 2023-12-01 floor is Patient Sources'
-- visit-history limit, which has nothing to do with ad files, and a saved
-- coverage that started earlier would make the page unloadable.
-- TOTAL order (date, platform, campaign_key, ad_key) = the table's unique key,
-- so PostgREST .range() paging can never drop or repeat a row.
create or replace function public.ad_spend_rows(p_from date, p_to date)
returns table (
  spend_date date, platform text, campaign_key text, campaign_label text,
  ad_key text, ad_label text, spend_php numeric, impressions int, clicks int,
  leads int, platform_bookings int
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.has_role(array['admin']) then
    raise exception 'Only admins can see ad spend' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 400 then
    raise exception 'Pick a period whose start is on or before its end, at most 400 days long'
      using errcode = '22023';
  end if;
  return query
  select a.spend_date, a.platform, a.campaign_key, a.campaign_label,
         a.ad_key, a.ad_label, a.spend_php, a.impressions, a.clicks,
         a.leads, a.platform_bookings
  from public.ad_spend_daily a
  where a.spend_date between p_from and p_to
  order by a.spend_date, a.platform, a.campaign_key, a.ad_key;
end;
$$;

-- ACLs restated: anon never; authenticated may call (each function checks admin itself).
revoke all on function public.ad_spend_import(uuid, jsonb, int) from public, anon;
grant execute on function public.ad_spend_import(uuid, jsonb, int) to authenticated;
revoke all on function public.ad_spend_rows(date, date) from public, anon;
grant execute on function public.ad_spend_rows(date, date) to authenticated;

-- Post-conditions.
do $$
declare
  v_def text;
  c text;
begin
  foreach c in array array['leads', 'platform_bookings', 'ad_label'] loop
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'ad_spend_daily' and column_name = c and is_nullable = 'YES') then
      raise exception '0203: ad_spend_daily.% is missing or not nullable', c;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.ad_spend_rows(date,date)', 'execute')
     or not has_function_privilege('authenticated', 'public.ad_spend_rows(date,date)', 'execute')
     or has_function_privilege('anon', 'public.ad_spend_import(uuid,jsonb,integer)', 'execute')
     or not has_function_privilege('authenticated', 'public.ad_spend_import(uuid,jsonb,integer)', 'execute') then
    raise exception '0203: wrong ACL on ad_spend_rows / ad_spend_import';
  end if;
  if has_table_privilege('anon', 'public.ad_spend_daily', 'select')
     or has_table_privilege('authenticated', 'public.ad_spend_daily', 'insert') then
    raise exception '0203: ad_spend_daily grants widened';
  end if;
  v_def := pg_get_functiondef('public.ad_spend_import(uuid,jsonb,integer)'::regprocedure);
  if v_def not like '%pg_advisory_xact_lock(hashtext(''ad_spend_import''))%' then raise exception '0203: import lost its advisory lock'; end if;
  if v_def not like '%[mixed breakdown]%' or v_def not like '%[breakdown change]%' then raise exception '0203: import lost a 0193 guard'; end if;
  if v_def not like '%platform_bookings = excluded.platform_bookings%' or v_def not like '%ad_label       = excluded.ad_label%' then
    raise exception '0203: import does not write the new fields';
  end if;
  v_def := pg_get_functiondef('public.ad_spend_rows(date,date)'::regprocedure);
  if v_def not like '%has_role%' or v_def not like '%order by a.spend_date, a.platform, a.campaign_key, a.ad_key%' then
    raise exception '0203: ad_spend_rows lost its admin gate or total order';
  end if;
end;
$$;
