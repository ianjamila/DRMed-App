---
name: drmed-staff-ui
description: Use when working on DRMed staff-portal UI "chrome" — the sidebar navigation, in-page section tabs, page headers and filter chips, dashboard summary cards, or printable slips. Trigger whenever the user mentions staff-nav-config, STAFF_NAV, StaffNavItem, StaffNavSection, adminOnly, collapsible, Hidden tabs, isSectionActive, sidebar nav, nav item, sidebar section/subgroup, visibleNavFor, isItemActive, activePrefix, activePrefixes, excludePrefixes, exact match nav, section tabs, SectionTabs, section-tabs-style, sectionTabClass, tab bar, VisitsTabs, BillsTabs, StatementTabs, PaymentsTabs, the cyan-vs-navy tab style, PageHeader, filter chips, multi-select chips, dashboard card, dashboard cards, cards.ts, DASHBOARD_CARDS, CardDef, defaultHidden, hiddenCardIdsFor, StatCard, dashboard_card_prefs, dashboard settings, dashboard-cards, role dashboard, admin-dashboard / reception-dashboard / lab-dashboard, the (dashboard) home page, print button, print slip, count sheet, @page, @media print, globals.css, or mobile layout at 390px. ALSO trigger on "add a sidebar item", "add / move / rename a nav link", "consolidate these sidebar items", "add a tab to this page", "make these tabs consistent", "the tabs jump when switching", "add a dashboard card", "hide a card for a role", "make this printable", or any plain-language relabel of a staff page. This is the UI-plumbing surface — money/result/RLS logic lives in drmed-payments / drmed-result-templates / drmed-rls-and-auth, not here.
---

# DRMed staff-portal UI wiring (nav · tabs · dashboard cards)

## What this is

The three "chrome" systems every staff page hangs off of: the **sidebar nav config**, the **shared section-tab component**, and the **role dashboard cards**. Reach for this when adding/moving/renaming a sidebar item, adding or consolidating in-page tabs, or adding a dashboard summary card. It is pure presentation plumbing — no payment, result, or RLS logic lives here (those are drmed-payments / drmed-result-templates / drmed-rls-and-auth).

## Where things live

| Concern | Location |
|---|---|
| Route and section names | `src/lib/staff/route-names.ts` (`ROUTE_NAME`, `SECTION_NAME`; dependency-free) |
| Sidebar nav config (the single source) | `src/components/staff/staff-nav-config.ts` |
| Shared section-tab component | `src/components/staff/section-tabs.tsx` (`SectionTabs`) |
| Tab styling for non-component bars | `src/components/staff/section-tabs-style.ts` |
| Per-area tab wrappers | `…/payments/_components/payments-tabs.tsx`, `…/admin/accounting/ap/_components/bills-tabs.tsx`, `…/visits/_components/visits-tabs.tsx`, `…/admin/accounting/financial-statements/_components/statement-tabs.tsx` |
| Fixed-position tab bar via layout | `…/admin/accounting/ap/layout.tsx`, `…/admin/operations/(daily-monitoring)/layout.tsx`, `…/admin/accounting/financial-statements/layout.tsx` |
| Page header (title, subtitle, actions slot) | `src/components/staff/page-header.tsx` (`PageHeader`) — the lab queue and Visits archive are the models for header + filter chips |
| Print buttons (client `window.print()` wrappers) | `…/visits/[id]/receipt/print-button.tsx`, `…/payments/eod/[closeId]/count-sheet/print-button.tsx`, `…/admin/accounting/pf-payouts/[id]/slip/slip-print-button.tsx` |
| Dashboard card registry | `src/lib/dashboards/cards.ts` |
| Card visibility loader | `src/lib/dashboards/card-prefs.ts` (`loadHiddenCardIds`) |
| Role dashboards | `src/app/(staff)/staff/(dashboard)/page.tsx` → `_dashboards/{reception,lab,admin}-dashboard.tsx` |
| Card component | `…/(dashboard)/_dashboards/_components/stat-card.tsx` (`StatCard`) |
| Brand theme tokens | `src/app/globals.css` (`--color-brand-*`) |
| Cron Health (admin-only, Operations nav subgroup) | `src/app/(staff)/staff/(dashboard)/admin/operations/cron-health/page.tsx` — beside the `(daily-monitoring)` route group, so no tab bar; canonical legs (with the plain `label` + `description` the page shows) + status rule in `src/lib/ops/cron-heartbeats.ts`, drift guards in `cron-heartbeats.test.ts` |

Roles everywhere: `reception`, `medtech`, `xray_technician`, `pathologist`, `admin`.

## 1 · Sidebar navigation — `staff-nav-config.ts`

`STAFF_NAV: StaffNavSection[]` drives the whole sidebar. A **section** has a `heading` and either flat `items`, collapsible `subgroups` (`{heading, items}`), or both, plus two optional flags: `adminOnly` (the whole section is dropped for non-admins regardless of item roles) and `collapsible` (rendered as a collapsed-by-default `<details>`; `isSectionActive()` opens it when a child is active). Current sections in order: Overview · Front Desk (Reception Queue, Patients, then subgroup Messages & Bookings = Appointments, Website Messages — Inquiries was retired by 0154, zero rows ever) · Billing (Visit Records, Quick Quote, Cash Drawer) · Lab & Imaging · Admin (subgroups Pay Doctors, Payroll, Books & Reports — first item **Send-out Labs** (0164) —, Operations, Catalog & Setup, Admin Tools) · Personal · **Hidden Tabs** (`adminOnly + collapsible` — parked pages the partner may want back; don't add live features there).

**Labels are Title Case** (owner decision 2026-09-15): "Reception Queue", "Quick Quote", "HMO Claims", "Run Payroll" — every sidebar item, section/subgroup heading, in-page tab and dashboard quick-link. Acronyms and brand names stay as-is (HMO, SSS, IndexNow). `staff-nav-config.test.ts` fails on a sentence-case label. A page's `<h1>` and `metadata.title` follow the label whenever the two differ ONLY by letter case ("Cash Drawer" opens a page headed "Cash Drawer"); a heading that is a genuinely different phrase ("Pay runs" under Run Payroll) is a naming decision, not a casing one, and stays until it is deliberately renamed. Buttons stay sentence case ("+ New visit", "+ New patient") — they are actions, not page names.

An **item** is a `StaffNavItem`:

```ts
{ href, label, description?, exact?, activePrefixes?, excludePrefixes?, roles }
```

- `quicklink` — dashboard audiences, order, optional group and role restriction; `quickLinksFor` / `quickLinkGroupsFor` derive every dashboard list from `STAFF_NAV`. Related form/tab links live in `shortcuts`, which never adds a sidebar row. Dashboard inclusion is independent of sidebar parking, but item roles still gate access.
- `description` — plain-English help through `src/components/ui/tooltip.tsx` in desktop and mobile navigation: hover/focus the info button, tap to toggle, Escape/outside press to dismiss. Links use `aria-describedby` and remain directly navigable. Add it for any item whose label involves jargon; skip for self-explanatory ones.
- `exact` — active only when `pathname === href` (use when `href` is too broad, e.g. `/staff`).
- `activePrefixes` — extra prefixes that ALSO light the item. This is the key to consolidation (below). List sibling routes individually; never a shared parent that also covers a route no item owns.
- `excludePrefixes` — sub-trees under `href` (or an active prefix) that must NOT light the item, because a sibling item owns them.
- `roles` — who sees it. `visibleNavFor(role)` filters items + subgroups and drops empties; `isItemActive(item, pathname)` / `isSubgroupActive` decide highlighting. Both renderers (`staff-nav.tsx`, `staff-mobile-nav-trigger.tsx`) put `aria-current="page"` on the active link, the same signal `SectionTabs` gives. **Every path must light at most ONE item** — `staff-nav-config.test.ts` asserts this for the routes that share a prefix (Patients ⊃ /new, Cash Drawer's three tabs, Visit Records vs queue/new).

**Consolidation pattern (collapse N sidebar items → 1 umbrella that opens to tabs).** Point the umbrella item's `href` at the default/first tab and list the sibling tab routes in `activePrefixes` so it stays highlighted across them. Live examples:

- **Cash Drawer**: `href: /staff/payments/cash-drawer`, `activePrefixes: ["/staff/payments/petty-cash", "/staff/payments/eod"]` (lands on the Cash In & Out tab, stays lit on the Petty Cash and End of Day tabs of `PaymentsTabs`; the sidebar item reads `SECTION_NAME` "Cash Drawer", the landing tab reads `ROUTE_NAME` "Cash In & Out"). The routes are listed one by one on purpose: `/staff/payments` would also light it on `/staff/payments/new` (Record payment), which no sidebar item owns.
- **Expenses**: `href: /staff/admin/accounting/ap` (lands on Overview and stays lit across AP descendants; Quick expense is an Overview header action).
- **Visit Records** (Billing): `href: /staff/visits` with `excludePrefixes: ["/staff/visits/new", "/staff/visits/queue"]` — the queue is owned by Front Desk › Reception Queue and the New visit form by no item (it is the queue's + New visit action), so the umbrella pattern is inverted here: exclusions, not `activePrefixes`.
- **Patients**: `href: /staff/patients` with NO exclusions — the default prefix match keeps it lit on `/staff/patients/new`, which is reached from the page's own + New patient button (the "New patient registration" item was removed 2026-09-15).
- **Financial Statements**: a single bare-base `href` — the default prefix match already covers `/balance-sheet` and `/cash-flow`, so no `activePrefixes` needed.
- **Cron Health** is its own admin item under Operations. **Daily Report** excludes `…/operations/cron-health` to avoid double highlighting. It is not a financial-period view, so it does not join `OperationsTabs` — and it cannot inherit them either: the six Daily Monitoring views live in the `admin/operations/(daily-monitoring)/` route group (URLs unchanged), whose `layout.tsx` owns the bar, while `cron-health/` sits beside the group with no eyebrow and its own padding. There is deliberately no `operations/layout.tsx`; `staff-nav-config.test.ts` fails if one reappears. A child layout can never opt out of a parent layout, so a route group is the only way to give one sibling a different frame. The page reads only system heartbeat timestamps with the staff RLS client; missing rows stay visible as Pending/Stale, and query errors are Unavailable. Pending means the initial monitoring grace period has not ended.

Before adding an `activePrefixes` entry, list every route under it and check none belongs to another item (or to nobody).

**Count badges.** `StaffNav` and `StaffMobileNavTrigger` take an optional `badges: Record<href, number>`; `NavBadge` (`src/components/staff/nav-badge.tsx`) renders a cyan pill (99+ cap, sr-only "N new") after the label, and a collapsed section/subgroup shows the summed total on its summary line (`itemBadgeCount` / `subgroupBadgeTotal` / `sectionBadgeTotal` in `staff-nav-config.ts`). The counts are fetched server-side in `src/app/(staff)/staff/(dashboard)/layout.tsx` (`loadNavBadges`, reception/admin only, RLS client, `head: true` count; any failure → no badge, reported, never thrown) and threaded through `StaffShell`. Today the only badge is Website Messages (`contact_messages.status = 'new'`). Layouts do not re-render on client navigation, so every action that changes a badged count must `revalidatePath("/staff", "layout")`.

## 2 · Section tabs — `SectionTabs` is the ONE tab component

`src/components/staff/section-tabs.tsx` is the canonical in-page tab bar (navy filled pill + underline rule). **The old cyan rounded-full pill style is deprecated — do not add new ones.** When you find one, migrate it.

```ts
interface SectionTab { href: string; label: string; exact?: boolean; excludePrefixes?: string[]; query?: string }
<SectionTabs tabs={TABS} label="…" query={qs} />
```

- Props are **serializable data only** — never pass a `match` *function*. The wrappers are server components, and a function prop crosses the server→client boundary and throws ("Functions cannot be passed to Client Components"). Encode active rules as data instead:
  - `exact: true` — active only on `href` (or `href + "/"`). For an "Overview"/"Income statement" tab whose href is a prefix of its siblings.
  - `excludePrefixes: [...]` — for the default prefix match, treat these sub-trees as NOT this tab (e.g. Archive at `/staff/visits` excludes `/staff/visits/new`).
- `query` — an already-built `"?date=…"` string appended to every tab href, to carry a selection across tabs. The **caller** reads `useSearchParams` and passes it in, so `SectionTabs` itself uses only `usePathname` and never triggers the dynamic-render bailout. A per-tab `query` on a `SectionTab` overrides the bar-level one, for a bar whose tabs take DIFFERENT params for the same selection.
- **Carrying the selection is not optional for a views-bar** — it is the one job the bar has, and it is invisible when missing (M3 in the SectionTabs audit: Operations and Financial statements both read a date range and neither bar passed it on, so every tab click silently reset the period). Build the string with `carryParams()` from `src/lib/reports/statement-period.ts` — it keeps only the listed keys, validates each as `YYYY-MM-DD` unless named in `unvalidated`, and returns `""` when nothing is selected so the target keeps its own default — rather than hand-rolling another `URLSearchParams` loop. Live callers: `PaymentsTabs` (`date`/`shift`), `OperationsTabs` (`from`/`to`).
- **When the tabs don't share a parameter, map — never pass through.** Financial statements is the case: the income statement and cash flow take `start`/`end`, the balance sheet takes a single `as_of` closing date. `statementPeriodQueries()` maps period → `as_of = end` and `as_of` → `start = 1 Jan of that year, end = as_of`, and `StatementTabs` hands each tab its own `query`. A blind passthrough would send `start`/`end` to a page that reads neither.
- Each tab set is a thin wrapper that just declares its `TABS` and renders `<SectionTabs/>` (see `bills-tabs.tsx`, `visits-tabs.tsx`, `statement-tabs.tsx`, `payments-tabs.tsx` — Cash In & Out | Petty Cash | End of Day, mounted by the cash-drawer and eod client components AND the petty-cash server page). A wrapper that carries a selection must be a **client** component. `src/components/staff/section-tabs-query.test.tsx` pins the rendered hrefs for the three that do.

**A tab bar has to be a set of views, not a set of URLs.** `SectionTabs` promises "different views of the same thing", so only group pages that share a subject. `visits-tabs.tsx` is the cautionary example: it was built as New visit | Archive (create vs browse the visit record), then the Reception Queue was dropped in for sharing the `/staff/visits` prefix — pairing a live day worklist with a records archive, under labels that contradicted the sidebar's own names for the same routes. The queue now renders no bar and carries a `+ New visit` **action** in its `PageHeader` `actions` slot instead. When a cross-page shortcut is genuinely useful but the pages aren't siblings, that's the shape to reach for.

**One route, one name — in every surface that points at it.** Navigation leaves, tab configs and dashboard quicklinks read `ROUTE_NAME[href]`. Section umbrellas read `SECTION_NAME[href]` (Expenses, Daily Monitoring, Financial Statements, Marketing, Cash Drawer); AP’s contextual Overview tab, role-adaptive Queue, and metric-card labels are documented exceptions in `staff-nav-config.test.ts`. That AST guard checks registry references and import bindings; `staff-page-titles.test.ts` owns metadata presence and suffixes. Never infer rendered headings by source-text scanning. A route is named in up to five places: the page `<h1>`, its `metadata.title`, the sidebar item in `staff-nav-config.ts`, any `SectionTabs` label, and the role-dashboard quicklinks in `_dashboards/*-dashboard.tsx`. They drift independently, and the drift is invisible until someone reads two of them side by side — `/staff/visits` was "Visits" in the sidebar, "Archive" in its tab and "Visits" in its own h1, while the `/staff/visits/new` picker *also* titled itself "Visits". Grep all five before renaming (the 2026-09-15 "Visit archive" → "Visit Records" rename touched the sidebar, `visits-tabs.tsx`, `visits/page.tsx` metadata + h1, the reception dashboard quick link and eight lines of the user guide), and when two sidebar items deliberately share one destination, have the page echo the entry point back — `PICKER_TITLE[filter ?? "none"]` — rather than picking one name and contradicting the other.

**Detail titles:** `detailMetadata` in `src/lib/staff/detail-metadata.ts` appends an authorized record identifier to `ROUTE_NAME`'s static fallback. The patient, visit/receipt, lab test/chemistry, payslip, inventory, gift code, payroll, bank statement, HMO and PF payout families share React-cached header lookups between `generateMetadata` and the page. Keep authorization before the lookup; test section/package checks and payslip ownership/run visibility live in the shared loaders. Metadata must not audit a print/view or consume a PIN flash. Lookup errors, missing rows and blank identifiers fall back to the static name. Extend `staff-page-titles.test.ts`, not a new guard.

**Param-driven bars that can't use the component** (e.g. a server-component scope filter like patient-AR's non-HMO/HMO/all) should import `sectionTabsNavClass` and `sectionTabClass(active)` from `section-tabs-style.ts` and apply them inline, so they match the navy style exactly without the client component.

**Fixed-position tab bar across sub-pages.** If a page group's tabs should never move when switching, put the container + tab bar in a route `layout.tsx` and have each page render only its body. `ap/layout.tsx` is the model: one `max-w-6xl` container + `<BillsTabs/>` + `{children}`; the six AP pages dropped their own container/tabs. This fixes the "tab bar jumps / changes width when I switch tabs" problem caused by per-page containers of differing `max-w`.

## 3 · Dashboard cards — `cards.ts` + role dashboards

The home dashboard at `/staff` routes by role to a `_dashboards/*-dashboard.tsx`, which renders summary `StatCard`s.

- **Registry** — `src/lib/dashboards/cards.ts`: `DASHBOARD_CARDS: CardDef[]`, where `CardDef = { id, label, roles, group, sensitive?, defaultHidden? }`. `group` is one of `'snapshot' | 'operations' | 'money' | 'people' | 'attention'`. The `id` (e.g. `admin.pf_to_pay`) is stored in `dashboard_card_prefs.card_id` — **renaming a `label` is safe; renaming an `id` drops any saved visibility override.** `cardsForRole(role)` filters.
- **Visibility** — table `dashboard_card_prefs (role, card_id, visible)` (migration `0068`). No row = the card's default (`defaultHidden ? hidden : visible`), so a new card needs no migration; a stored pref always wins, so admin can re-enable a default-hidden card from Dashboard settings. `loadHiddenCardIds(role)` (card-prefs.ts) applies `hiddenCardIdsFor()` / `matchesCardDefault()` from cards.ts; the settings UI at `/staff/admin/settings/dashboard-cards` loops `DASHBOARD_CARDS` per role. Example: reception's "Gift codes sold" ships `defaultHidden: true`.
- **Render + data** — each dashboard builds `show = (id) => !hidden.has(id)`, then runs ONE `Promise.all` of queries each gated by `show("id") ? query : SKIP_COUNT/SKIP_DATA` (hidden cards cost no query), aggregates into a `stats` object, and renders `{show("id") && <StatCard … />}`. `StatCard` props: `label`, `value`, `hint`, `href`, `accent` (`'default' | 'warn' | 'good'`) — it's text-only, there is no icon slot.

**To add an admin card** (e.g. the "Doctors to pay" card):
1. Add a `CardDef` to `DASHBOARD_CARDS` (`{ id, label, roles:["admin"], group:"money", sensitive:true }`).
2. In `admin-dashboard.tsx`: add a query to the `Promise.all` gated by `show("your.id")` (else `SKIP_DATA`), destructure it, aggregate into the returned `stats`.
3. Render `{show("your.id") && <StatCard label=… value=… hint=… href=… accent=… />}` next to a sibling card.

No migration is required — absence of a prefs row means visible.

## 4 · List pages — header, filter chips, paging

The lab queue (`/staff/queue`) and the Visits archive (`/staff/visits`) are the reference list pages: `PageHeader` on top, status tabs via `SectionTabs`, filter chips that round-trip through search params (multi-select chips serialise to a comma list — see `parseVisitClasses` / `serialiseVisitClasses` in `src/lib/visits/classification.ts`), a date picker with prev/next/"Back to today", and real paging (`count: "exact"` + `.range()`, one page size for every tab so the page doesn't resize when switching). Tab links and Clear reset to page 1; page links keep the filters. When a search can only run post-fetch (an ILIKE across an embed isn't expressible in one PostgREST query), say so in the subtitle rather than implying a miss means "not in the list".

### The shared list contract — use it, don't re-hand-roll it

Every staff list page speaks one URL contract: `?sort=&dir=&page=&size=`,
parsed by `src/lib/ui/table-params.ts` and rendered by
`src/components/staff/{sortable-th,list-pagination}.tsx`. A new list page wires
these, it does not grow its own pager.

- `parseSort(raw, rawDir, allowed, fallback)` — `allowed` is a **security
  boundary**, not a UI list: the key reaches a PostgREST `.order()`. Declare it
  `as const` on the page and include only columns the table visibly shows.
- Every ordering ends `.order("id", { ascending: true })`. Without a total
  order `.range()` drops and repeats rows between pages.
- A column computed AFTER the fetch cannot be ordered — render it with
  `PlainTh` (Visits' Tests count, Journal's Type/Amount, Emails sent's
  Recipient/Email/Status, the Patient column on the two `test_requests`
  worklists, which sits two embeds down).
- Sort, filter and size changes all reset to page 1; tab and chip links keep
  the sort. A plain-GET filter `<form>` needs hidden `sort`/`dir`/`size`
  inputs or Apply silently resets them.
- Where the default order differs per tab (`/staff/results` Unclaimed,
  `/staff/queue` Released today), compute `defaultSort` from the tab and ask
  "is this the default?" against THAT, so the URL stays bare on each tab.
- **Client-state twin:** `src/components/staff/client-table-controls.tsx`
  (`ClientSortableTh` / `ClientListPagination`) renders the same chrome as
  buttons, from the same class helpers and the same pure decision functions.
  It exists for exactly one case — HMO claims, whose rows are already in the
  browser and whose checkbox selection a URL navigation would discard. Reach
  for it only when moving page state into the URL would cost a refetch or lose
  state; everything else uses the link version and its zero hydration.

## 4a · The three page-shape standards (agreed 2026-09-11)

Staff pages visibly jumped as you navigated between them. Measured across the
**151** `page.tsx` files under `src/app/(staff)/staff/`: only 9 used
`PageHeader`, **9 different container widths** were in use, and **35 pages had
no outer container at all**. These are the three rules that fix it. Apply them
to any page you touch; don't blind-sweep the whole tree.

**1 · Width belongs to the shell, not the page.**
`StaffShell`'s `<main>` owns the width: `mx-auto w-full max-w-screen-2xl`.
A page adds **no** `mx-auto max-w-*` of its own — a different `max-w` per page
is exactly what made the column shift sideways between routes.

**The shell deliberately does NOT own the padding.** Pages keep their own
`px-4 py-8 sm:px-6 lg:px-8`. This is the whole reason conversion can be
incremental: if the shell padded too, every page still carrying its own would
double-pad, so the sweep would have to be all-or-nothing across 151 files.
Converting a page therefore means deleting only its `mx-auto max-w-*` and
leaving the padding alone.

A page that is *deliberately* narrow — a single-column focused form (new visit,
new journal entry, login) — keeps a narrow wrapper on its FORM, inside the
shell's container, never on the page root. Narrow is then a property of the
form, not of the route, so the page frame stays put while the content inside it
is as wide as it should be.

**2 · One header component.** Every page opens with `PageHeader`
(`title`, optional `eyebrow`, `subtitle`, and `actions`). In Expenses, Daily Monitoring, Financial Statements, Marketing and Cash Drawer (its three tab pages; the printed count sheet is exempt), use `eyebrow={SECTION_NAME[sectionHref]}`; never repeat the kicker in the layout or hand-roll it above the header. The existing nav guard enforces this component contract.

**Never put controls in `actions` beside a subtitle whose length varies.** They
share one `flex flex-wrap items-start justify-between` row, so a longer
subtitle pushes the controls onto a new line and a shorter one pulls them back
up — the controls visibly jump as the reader uses the page. If the subtitle
carries a count, a filter echo or anything data-dependent, put the controls in
a **sibling below the header** instead. The lab queue (`queue/page.tsx`) has
the canonical comment explaining this; the registration-link button popping
under the sidebar was the same root cause.

**3 · One date format: `Sep 11, 2026`.** Use `manilaDate`, `manilaDateTime`
(`Sep 11, 2026, 2:06 PM`) and `manilaTime` from `@/lib/dates/manila`. Never
call `toLocaleDateString` / `toLocaleString` directly in a page.

The old bug was **not** a locale bug — worth understanding so it isn't
reintroduced. `toLocaleString("en-PH", { timeZone: "Asia/Manila" })` with no
`dateStyle` or `month` field defaults to **numeric** `9/11/2026`, which is
genuinely ambiguous for a PH clinic (9 November or 11 September?). Every
explicit `"en-US"` call in this repo already passes a named `month`/`weekday`
and was always fine. The rule is therefore *always go through the helper*,
never *"use en-PH"*.

## 5 · Printable slips

Every print surface follows the same shape (receipts, portal-access slip, EOD count sheet, PF payout slip):

- A server page under the resource's route (`…/receipt`, `…/count-sheet`, `…/slip`) that gates with the right `require*Staff()`, **audit-logs the view/print** (the slip discloses patient data), and renders the sheet plus a small client `print-button.tsx` that calls `window.print()`.
- Its own **named `@page`** + `@media print` block appended at the **tail of `src/app/globals.css`** (`receipt` A5, `cash-count` A5, `payout-slip` A4 — pick A4 when an itemised table plus signature blocks would spill at A5). Print media hides the nav/shell; multiple copies use `break-after: page`.
- Because every print PR appends at the same spot in `globals.css`, two print PRs in flight always conflict there — the resolution is keep both blocks.
- Don't "fix" print width with `print:max-w-none`: `max-width` never widens an element, and in paged media the page area is the containing block, so the cap never binds.
- **The shell must not wrap a print surface in a scroll box or an in-flow widget.** `StaffShell`'s `<main>` scrolls wide tables on screen (`overflow-x-auto`) and is `print:overflow-visible` — printed, a scroll box is clipped with its scrollbar drawn in on any Mac showing scroll bars, which cut the right edge and the whole portal-access block off receipts (2026-09-24). The dashboard layout wraps sonner's `<Toaster>` in `print:hidden` because its empty live region alone pushed a blank last page. Verify a print change with real Chrome, not the headless shell: `chromium.launch({ channel: "chrome", ignoreDefaultArgs: ["--hide-scrollbars"] })` + `page.pdf({ preferCSSPageSize: true })` — the default headless shell hides scrollbars and never reproduces the clip.
- **A printed `<tfoot>` repeats at the foot of every page**, so a multi-page bill shows the grand total under a partial list (it did on the PF payout slip). One global rule in `globals.css` prints every `tfoot` as `table-row-group` — once, at the end; don't re-add a per-table class. Before this PR the count sheet and both consent forms also printed a trailing blank page (the Toaster). Both receipts render their lines through the shared `src/components/staff/receipt-lines-table.tsx` (package components sit under their header with blank amounts via `arrangeReceiptRows` in `src/lib/visits/receipt-totals.ts`) — change the table there, not per page.

## Theme

Use the `var(--color-brand-*)` tokens from `globals.css`, never raw hex: navy `#284570`, cyan `#06aef1`, cyan-mid `#3eafe3`, bg `#f0f6fc`, bg-mid `#e3eef9`, text `#1a2537`, text-soft `#6b7280`.

## Plain language by audience (a hard product rule)

The partner cares strongly about this:

- **Reception-facing pages** (cash drawer, pay doctors, new visit): no jargon. Humanize any raw enum shown to users (`petty_cash` → "Petty cash", `bank_transfer` → "Bank transfer") and avoid accounting words (Opening float → "Starting cash", Variance → "Difference (over/short)").
- **Bookkeeper / accounting pages** (journal, AP, financial statements): KEEP the load-bearing terms — debit/credit, BIR codes (`WI160`, Form `1601-EQ`), "Pending HMO settlement". Add a plain hint beside them rather than renaming; renaming would be *wrong* (e.g. debit ≠ "money in" for every account type).
- When you can't tell which audience a screen serves, ask.

## Gotchas

- Adding a new `layout.tsx` or route can make `npm run typecheck` flag a stale generated route-manifest validator (`LayoutRoutes`/`Route` mismatch under `.next/dev/types`). It's a **false positive** that clears on `npm run build`; your source files are fine.
- Internal navigation must use `next/link` `<Link>`, not `<a>` (eslint `@next/next/no-html-link-for-pages`).
- New pages must work at 390×844 (mobile-first) before shipping — reuse the mobile drawer; tables need `overflow-x-auto`.
- Server → client props must be serialisable data (no functions); route params are async in Next 16 (`await params`).
- Browsers compile an `<input pattern>` with the RegExp `v` flag: a bare trailing `-` in a character class is a syntax error and the whole pattern is then **silently ignored**. Escape it (`[a-z0-9\-]+`); moving it to the front also fails under `v`.
- The visit page splits SEE from ACT (owner decision, 2026-09-15 — reverses an earlier go-live rule that read `sectionsForRole("reception") === []` as "hide every row from reception"). Reception now sees every bill line — name, code, price, discount, status — because it enters and collects the bill, but may not ACT on the result behind any of them (no MarkDoneButton/ReleaseButton/UndoReleaseDialog, no "Open in queue" bench link — it gets a read-only status hint instead). **One exception (owner decision 2026-09-24):** a RELEASED lab/imaging line shows reception `Print result` + `View PDF →`, and reception gets Lab & Imaging › Queue locked to its `Released today` tab (the page redirects every other tab, hides the tab bar, the Mine toggle, Remarks and every bench link, and titles itself "Released results"). The PDF gate is `canViewResultPdf(role, { section, status, kind })` in `line-visibility.ts` — the route `/staff/results/[id]/pdf` enforces it and both pages call it, with `resultPdfStates` (`src/lib/results/pdf-availability.ts`: newest link must carry a file AND every test on that shared file must be released, mirroring the route) deciding what the row offers; on Released today the queue folds a chemistry panel per result FILE (`reportCardKey`), so a panel split over two PDFs gets one Print per file. Every Print button carries a `PrintedNote` (`src/components/staff/printed-note.tsx`: "Printed 10:42 AM by … · 2 times", keyed by result FILE, so a shared chemistry PDF printed from one member shows on all). The visit page offers `Print all released results (N reports)` beside the Tests heading from two reports up (`PrintResultButton src=…/results-pdf`); the button calls `router.refresh()` after a print so the note updates. The shared button is `src/components/staff/print-result-button.tsx`: a tab reserved synchronously in the click → fetch `?print=1` (audits `result.printed_staff`) → blob URL in that tab, where the PDF viewer prints; a blocked tab becomes an "Open the PDF to print" link. Never an off-screen iframe + `print()`: Chrome 153 hosts a framed PDF in a cross-origin viewer frame, so `contentWindow.print()` throws (verified headed, 2026-09-25). `sectionsForRole` still governs who may ACT on a result, and `[]` is still a DENY there, never "no filter" — it just no longer governs *visibility*. The two predicates (`canSeeLine`, `canActOnResult`, plus the page-level `roleCanActOnResults`) live in `src/lib/visits/line-visibility.ts`, built on top of `sectionsForRole` rather than duplicating its section table.
- The nav config and the mobile trigger have vitest coverage (`staff-nav-config.test.ts`, `staff-nav.test.tsx`, rendered with `renderToStaticMarkup`) — extend them when adding sections/flags.
