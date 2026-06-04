-- 0092_visit_source_new_repeat.sql
-- Per-visit "new vs repeat customer" marker, recovered from the legacy master
-- sheet (LAB SERVICE col 17). Nullable: NULL = unknown / not recovered. Live
-- visits leave it NULL and the dashboard computes new-vs-repeat from visit
-- history; historical lab visits get the clinic's own hand-tracked value.
alter table public.visits
  add column source_new_repeat text
    check (source_new_repeat in ('new', 'repeat'));
