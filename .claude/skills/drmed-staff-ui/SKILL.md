---
name: drmed-staff-ui
description: Use when working on DRMed staff-portal UI "chrome" — the sidebar navigation, in-page section tabs, page headers and filter chips, dashboard summary cards, or printable slips. Trigger whenever the user mentions staff-nav-config, STAFF_NAV, StaffNavItem, StaffNavSection, adminOnly, collapsible, Hidden tabs, isSectionActive, sidebar nav, nav item, sidebar section/subgroup, visibleNavFor, isItemActive, activePrefix, exact match nav, section tabs, SectionTabs, section-tabs-style, sectionTabClass, tab bar, VisitsTabs, BillsTabs, StatementTabs, PaymentsTabs, the cyan-vs-navy tab style, PageHeader, filter chips, multi-select chips, dashboard card, dashboard cards, cards.ts, DASHBOARD_CARDS, CardDef, defaultHidden, hiddenCardIdsFor, StatCard, dashboard_card_prefs, dashboard settings, dashboard-cards, role dashboard, admin-dashboard / reception-dashboard / lab-dashboard, the (dashboard) home page, print button, print slip, count sheet, @page, @media print, globals.css, or mobile layout at 390px. ALSO trigger on "add a sidebar item", "add / move / rename a nav link", "consolidate these sidebar items", "add a tab to this page", "make these tabs consistent", "the tabs jump when switching", "add a dashboard card", "hide a card for a role", "make this printable", or any plain-language relabel of a staff page. This is the UI-plumbing surface — money/result/RLS logic lives in drmed-payments / drmed-result-templates / drmed-rls-and-auth, not here.
---

# DRMed staff-portal UI wiring (nav · tabs · dashboard cards)

## What this is

The three "chrome" systems every staff page hangs off of: the **sidebar nav config**, the **shared section-tab component**, and the **role dashboard cards**. Reach for this when adding/moving/renaming a sidebar item, adding or consolidating in-page tabs, or adding a dashboard summary card. It is pure presentation plumbing — no payment, result, or RLS logic lives here (those are drmed-payments / drmed-result-templates / drmed-rls-and-auth).

## Where things live

| Concern | Location |
|---|---|
| Sidebar nav config (the single source) | `src/components/staff/staff-nav-config.ts` |
| Shared section-tab component | `src/components/staff/section-tabs.tsx` (`SectionTabs`) |
| Tab styling for non-component bars | `src/components/staff/section-tabs-style.ts` |
| Per-area tab wrappers | `…/payments/_components/payments-tabs.tsx`, `…/admin/accounting/ap/_components/bills-tabs.tsx`, `…/visits/_components/visits-tabs.tsx`, `…/admin/accounting/financial-statements/_components/statement-tabs.tsx` |
| Fixed-position tab bar via layout | `…/admin/accounting/ap/layout.tsx` |
| Page header (title, subtitle, actions slot) | `src/components/staff/page-header.tsx` (`PageHeader`) — the lab queue and Visits archive are the models for header + filter chips |
| Print buttons (client `window.print()` wrappers) | `…/visits/[id]/receipt/print-button.tsx`, `…/payments/eod/[closeId]/count-sheet/print-button.tsx`, `…/admin/accounting/pf-payouts/[id]/slip/slip-print-button.tsx` |
| Dashboard card registry | `src/lib/dashboards/cards.ts` |
| Card visibility loader | `src/lib/dashboards/card-prefs.ts` (`loadHiddenCardIds`) |
| Role dashboards | `src/app/(staff)/staff/(dashboard)/page.tsx` → `_dashboards/{reception,lab,admin}-dashboard.tsx` |
| Card component | `…/(dashboard)/_dashboards/_components/stat-card.tsx` (`StatCard`) |
| Brand theme tokens | `src/app/globals.css` (`--color-brand-*`) |

Roles everywhere: `reception`, `medtech`, `xray_technician`, `pathologist`, `admin`.

## 1 · Sidebar navigation — `staff-nav-config.ts`

`STAFF_NAV: StaffNavSection[]` drives the whole sidebar. A **section** has a `heading` and either flat `items`, collapsible `subgroups` (`{heading, items}`), or both, plus two optional flags: `adminOnly` (the whole section is dropped for non-admins regardless of item roles) and `collapsible` (rendered as a collapsed-by-default `<details>`; `isSectionActive()` opens it when a child is active). Current sections in order: Overview · Front desk · Billing · Services · Lab · Admin (subgroups Pay doctors, Payroll, Books & reports, Operations, Catalog & setup, Admin tools) · Personal · **Hidden tabs** (`adminOnly + collapsible` — parked pages the partner may want back; don't add live features there).

An **item** is a `StaffNavItem`:

```ts
{ href, label, description?, exact?, activePrefix?, roles }
```

- `description` — plain-English hover tooltip + small info icon. Add it for any item whose label involves jargon; skip for self-explanatory ones.
- `exact` — active only when `pathname === href` (use when `href` is too broad, e.g. `/staff`).
- `activePrefix` — an extra prefix that ALSO lights the item. This is the key to consolidation (below).
- `roles` — who sees it. `visibleNavFor(role)` filters items + subgroups and drops empties; `isItemActive(item, pathname)` / `isSubgroupActive` decide highlighting.

**Consolidation pattern (collapse N sidebar items → 1 umbrella that opens to tabs).** Point the umbrella item's `href` at the default/first tab and set `activePrefix` to the shared base so it stays highlighted across the sibling tabs. Live examples:

- **Cash drawer**: `href: /staff/payments/cash-drawer`, `activePrefix: /staff/payments/eod` (lands on Cash drawer, stays lit on End of day).
- **Expenses**: `href: /staff/admin/accounting/ap/quick-expense`, `activePrefix: /staff/admin/accounting/ap` (lands on Quick expense, lit across all AP tabs).
- **Visit archive** (Billing): `href: /staff/visits` with `excludePrefixes: ["/staff/visits/new", "/staff/visits/queue"]` — the two sibling routes are owned by other sidebar items (Services › New lab/imaging request, Front desk › Reception Queue), so the umbrella pattern is inverted here: exclusions, not an `activePrefix`.
- **Financial statements**: a single bare-base `href` — the default prefix match already covers `/balance-sheet` and `/cash-flow`, so no `activePrefix` needed.

Avoid an `activePrefix` so broad it lights the item on unrelated sibling routes (e.g. don't use `/staff/payments` if `/staff/payments/new` shouldn't highlight it).

## 2 · Section tabs — `SectionTabs` is the ONE tab component

`src/components/staff/section-tabs.tsx` is the canonical in-page tab bar (navy filled pill + underline rule). **The old cyan rounded-full pill style is deprecated — do not add new ones.** When you find one, migrate it.

```ts
interface SectionTab { href: string; label: string; exact?: boolean; excludePrefixes?: string[] }
<SectionTabs tabs={TABS} label="…" query={qs} />
```

- Props are **serializable data only** — never pass a `match` *function*. The wrappers are server components, and a function prop crosses the server→client boundary and throws ("Functions cannot be passed to Client Components"). Encode active rules as data instead:
  - `exact: true` — active only on `href` (or `href + "/"`). For an "Overview"/"Income statement" tab whose href is a prefix of its siblings.
  - `excludePrefixes: [...]` — for the default prefix match, treat these sub-trees as NOT this tab (e.g. Archive at `/staff/visits` excludes `/staff/visits/new`).
- `query` — an already-built `"?date=…"` string appended to every tab href, to carry a selection across tabs. The **caller** reads `useSearchParams` and passes it in, so `SectionTabs` itself uses only `usePathname` and never triggers the dynamic-render bailout. (`PaymentsTabs` does this for `date`/`shift`.)
- Each tab set is a thin wrapper that just declares its `TABS` and renders `<SectionTabs/>` (see `bills-tabs.tsx`, `visits-tabs.tsx`, `statement-tabs.tsx`, `payments-tabs.tsx`).

**A tab bar has to be a set of views, not a set of URLs.** `SectionTabs` promises "different views of the same thing", so only group pages that share a subject. `visits-tabs.tsx` is the cautionary example: it was built as New visit | Archive (create vs browse the visit record), then the Reception Queue was dropped in for sharing the `/staff/visits` prefix — pairing a live day worklist with a records archive, under labels that contradicted the sidebar's own names for the same routes. The queue now renders no bar and carries a `+ New visit` **action** in its `PageHeader` `actions` slot instead. When a cross-page shortcut is genuinely useful but the pages aren't siblings, that's the shape to reach for.

**One route, one name — in every surface that points at it.** A route is named in up to five places: the page `<h1>`, its `metadata.title`, the sidebar item in `staff-nav-config.ts`, any `SectionTabs` label, and the role-dashboard quicklinks in `_dashboards/*-dashboard.tsx`. They drift independently, and the drift is invisible until someone reads two of them side by side — `/staff/visits` was "Visits" in the sidebar, "Archive" in its tab and "Visits" in its own h1, while the `/staff/visits/new` picker *also* titled itself "Visits". Grep all five before renaming, and when two sidebar items deliberately share one destination (Services' `?filter=lab`/`?filter=imaging` both open `/staff/visits/new`), have the page echo the entry point back — `PICKER_TITLE[filter ?? "none"]` — rather than picking one name and contradicting the other.

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
(`title`, optional `subtitle`, optional `actions`). Don't hand-roll an `<h1>`
block, and don't add an eyebrow line above the title — no sibling has one.

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
- Reception sees no per-test rows on the visit page (`sectionsForRole("reception") === []`), so per-line affordances there are effectively admin-only; reception acts on whole visits from the reception queue.
- The nav config and the mobile trigger have vitest coverage (`staff-nav-config.test.ts`, `staff-nav.test.tsx`, rendered with `renderToStaticMarkup`) — extend them when adding sections/flags.
