-- 0098_services_senior_pwd_eligible.sql
-- Senior/PWD eligibility flag on the service catalog. The 20% senior/PWD
-- discount only legally applies to a service's own price; bundled lab packages
-- are already sold at a discount, so they must NOT receive a further 20% off.
-- Defaults to true (most lab tests / consults / procedures ARE eligible);
-- packages are flipped to false. Admins can re-point individual services
-- (e.g. clinic price-sheet "*"-marked items) via the Services editor.
--
-- Forward-looking only: historical visits keep whatever senior discount was
-- genuinely applied at the time (books are reconciled). This flag gates the
-- quote workbench + new-visit form going forward, not past test_requests.
alter table public.services
  add column senior_pwd_eligible boolean not null default true;

-- Structural defaults confirmed against the clinic's April-2026 price sheet
-- (services with a blank "SENIOR PRICE" column): lab packages (already bundled
-- at a discount) and send-out tests (the "*"-marked rows) don't carry the 20%
-- senior/PWD rate. A few other sheet rows are also blank (4 home services, a
-- handful of X-rays/vaccines/urine electrolytes), but those read as sheet
-- omissions rather than policy — every sibling X-ray/urine test IS discounted —
-- so they stay eligible by default; the partner can untick any genuine
-- exceptions in the Services editor.
update public.services
  set senior_pwd_eligible = false
  where kind = 'lab_package' or is_send_out;
