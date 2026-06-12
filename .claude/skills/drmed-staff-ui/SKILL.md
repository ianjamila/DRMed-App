---
name: drmed-staff-ui
description: Use when working on DRMed staff-portal UI "chrome" — the sidebar navigation, in-page section tabs, or dashboard summary cards. Trigger whenever the user mentions staff-nav-config, STAFF_NAV, StaffNavItem, StaffNavSection, sidebar nav, nav item, sidebar section/subgroup, visibleNavFor, isItemActive, activePrefix, exact match nav, section tabs, SectionTabs, section-tabs-style, sectionTabClass, tab bar, VisitsTabs, BillsTabs, StatementTabs, PaymentsTabs, the cyan-vs-navy tab style, dashboard card, dashboard cards, cards.ts, DASHBOARD_CARDS, CardDef, StatCard, dashboard_card_prefs, dashboard settings, dashboard-cards, role dashboard, admin-dashboard / reception-dashboard / lab-dashboard, or the (dashboard) home page. ALSO trigger on "add a sidebar item", "add / move / rename a nav link", "consolidate these sidebar items", "add a tab to this page", "make these tabs consistent", "the tabs jump when switching", "add a dashboard card", "hide a card for a role", or any plain-language relabel of a staff page. This is the UI-plumbing surface — money/result/RLS logic lives in drmed-payments / drmed-result-templates / drmed-rls-and-auth, not here.
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
| Dashboard card registry | `src/lib/dashboards/cards.ts` |
| Card visibility loader | `src/lib/dashboards/card-prefs.ts` (`loadHiddenCardIds`) |
| Role dashboards | `src/app/(staff)/staff/(dashboard)/page.tsx` → `_dashboards/{reception,lab,admin}-dashboard.tsx` |
| Card component | `…/(dashboard)/_dashboards/_components/stat-card.tsx` (`StatCard`) |
| Brand theme tokens | `src/app/globals.css` (`--color-brand-*`) |

Roles everywhere: `reception`, `medtech`, `xray_technician`, `pathologist`, `admin`.

## 1 · Sidebar navigation — `staff-nav-config.ts`

`STAFF_NAV: StaffNavSection[]` drives the whole sidebar. A **section** has a `heading` and either flat `items`, collapsible `subgroups` (`{heading, items}`), or both. An **item** is a `StaffNavItem`:

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
- **Visits**: `href: /staff/visits/new`, `activePrefix: /staff/visits`.
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

**Param-driven bars that can't use the component** (e.g. a server-component scope filter like patient-AR's non-HMO/HMO/all) should import `sectionTabsNavClass` and `sectionTabClass(active)` from `section-tabs-style.ts` and apply them inline, so they match the navy style exactly without the client component.

**Fixed-position tab bar across sub-pages.** If a page group's tabs should never move when switching, put the container + tab bar in a route `layout.tsx` and have each page render only its body. `ap/layout.tsx` is the model: one `max-w-6xl` container + `<BillsTabs/>` + `{children}`; the six AP pages dropped their own container/tabs. This fixes the "tab bar jumps / changes width when I switch tabs" problem caused by per-page containers of differing `max-w`.

## 3 · Dashboard cards — `cards.ts` + role dashboards

The home dashboard at `/staff` routes by role to a `_dashboards/*-dashboard.tsx`, which renders summary `StatCard`s.

- **Registry** — `src/lib/dashboards/cards.ts`: `DASHBOARD_CARDS: CardDef[]`, where `CardDef = { id, label, roles, group, sensitive? }`. `group` is one of `'snapshot' | 'operations' | 'money' | 'people' | 'attention'`. The `id` (e.g. `admin.pf_to_pay`) is stored in `dashboard_card_prefs.card_id` — **renaming a `label` is safe; renaming an `id` drops any saved visibility override.** `cardsForRole(role)` filters.
- **Visibility** — table `dashboard_card_prefs (role, card_id, visible)` (migration `0068`). No row = visible (the default), so a new card needs no migration. A `visible=false` row hides it. `loadHiddenCardIds(role)` returns the hidden set; the settings UI at `/staff/admin/settings/dashboard-cards` loops `DASHBOARD_CARDS` per role.
- **Render + data** — each dashboard builds `show = (id) => !hidden.has(id)`, then runs ONE `Promise.all` of queries each gated by `show("id") ? query : SKIP_COUNT/SKIP_DATA` (hidden cards cost no query), aggregates into a `stats` object, and renders `{show("id") && <StatCard … />}`. `StatCard` props: `label`, `value`, `hint`, `href`, `accent` (`'default' | 'warn' | 'good'`) — it's text-only, there is no icon slot.

**To add an admin card** (e.g. the "Doctors to pay" card):
1. Add a `CardDef` to `DASHBOARD_CARDS` (`{ id, label, roles:["admin"], group:"money", sensitive:true }`).
2. In `admin-dashboard.tsx`: add a query to the `Promise.all` gated by `show("your.id")` (else `SKIP_DATA`), destructure it, aggregate into the returned `stats`.
3. Render `{show("your.id") && <StatCard label=… value=… hint=… href=… accent=… />}` next to a sibling card.

No migration is required — absence of a prefs row means visible.

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
