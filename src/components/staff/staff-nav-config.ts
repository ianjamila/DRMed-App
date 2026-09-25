import { ROUTE_NAME, SECTION_NAME } from "@/lib/staff/route-names";
import { QUICK_QUOTE_ROLES } from "@/lib/staff/quote-access";
// Sidebar nav items and which roles can see each.
// Used by StaffShell to render a role-filtered list.

import type { StaffSession } from "@/lib/auth/require-staff";

export type StaffRole = StaffSession["role"];

export type DashboardAudience = "admin" | "reception" | "lab";

export interface StaffNavItem {
  href: string;
  label: string;
  quicklink?: Partial<Record<DashboardAudience, {
    order: number;
    group?: string;
    roles?: readonly StaffRole[];
    routeName?: boolean;
  }>>;
  // Related destinations used by dashboard shortcuts, not sidebar rows.
  shortcuts?: StaffNavItem[];
  // Plain-English description shown as a hover tooltip + small info icon. Use
  // it for any item whose name involves jargon (accounting terms, abbreviations,
  // domain shorthand). Skip for items whose label is already self-explanatory
  // (e.g. "Patients", "Appointments", "My profile").
  description?: string;
  // The current path is "active" if it equals href OR starts with `${href}/`.
  // Override with a custom matcher when needed (e.g. /staff is too broad).
  exact?: boolean;
  // Extra prefixes that also mark this item active. Use when href points at
  // one tab of a tabbed page and the item should stay lit on the sibling tabs
  // (Cash Drawer lands on its Cash In & Out tab and stays lit on the
  // Petty Cash and End of Day tabs). List the sibling routes individually —
  // never a shared parent like /staff/payments, which would also light the
  // item on /staff/payments/new (Record payment), a route no sidebar item owns.
  activePrefixes?: string[];
  // Sub-trees that should NOT mark this item active even though they fall under
  // `href`'s prefix (or one of `activePrefixes`). Mirrors SectionTabs'
  // excludePrefixes — e.g. "Visit Records" at /staff/visits excludes
  // /staff/visits/new (the New visit form, which no sidebar item owns — it is
  // reached from the Reception Queue's + New visit button).
  excludePrefixes?: string[];
  // Draw a thin unlabeled rule above this item to split a long list into
  // visual groups without adding another heading (Front Desk: daily flow |
  // money; Books & Reports: books | reports; Catalog & Setup: catalog |
  // accounting setup; Admin Tools: people & logs | settings | patient data;
  // Operations: clinic ops | sales & marketing; Payroll: pay cycle | staff
  // records | setup). Works in sections and subgroups alike. Skipped when the item is the first one a role can see,
  // so a filtered list never opens with a stray line.
  dividerBefore?: boolean;
  roles: readonly StaffRole[];
}

// A subgroup sits inside a section and renders as a collapsible
// <details>/<summary>. Used to break up the 30+-item Admin section
// into scan-able buckets ordered roughly by daily use → setup.
export interface StaffNavSubgroup {
  heading: string;
  items: StaffNavItem[];
}

// A section can have flat items, collapsible subgroups, or both. Flat
// items render first (no chevron), then subgroups follow. At least one
// of items / subgroups must be present.
export type StaffNavSection = {
  heading: string;
  items?: StaffNavItem[];
  subgroups?: StaffNavSubgroup[];
  // Render the whole section as a collapsed-by-default <details>, the way
  // subgroups already render. Auto-expands when the current route is inside
  // it (see isSectionActive) so the user's location is never buried.
  collapsible?: boolean;
  // Hard admin gate applied on top of each item's own `roles`. Items keep
  // their real role lists (that's the record of who the page is FOR, and what
  // comes back if the section is ever unparked), but while this flag is set
  // the section — and everything in it — is dropped for every non-admin role.
  adminOnly?: boolean;
};

export const STAFF_NAV: StaffNavSection[] = [
  {
    heading: "Overview",
    items: [
      {
        href: "/staff",
        label: ROUTE_NAME["/staff"],
        exact: true,
        roles: ["reception", "medtech", "pathologist", "admin", "xray_technician"],
      },
    ],
  },
  {
    // Sits above Front Desk (owner request, 2026-09-24): the "someone is
    // asking" pages are the first thing reception checks, so they get their
    // own always-open section at the top. Quick Quote joins them — a quote is
    // how reception answers a price inquiry from either page.
    heading: "Messages & Bookings",
    items: [
      {
        href: "/staff/appointments",
        quicklink: {"reception":{"order":0,"group":"Messages & Bookings"}},
        label: ROUTE_NAME["/staff/appointments"],
        description: "Today's scheduled patients and walk-in slots, filterable by Consultations / Home service. Mark patients arrived to start their visit, or reschedule no-shows. View other days using the date picker.",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/messages",
        quicklink: {"reception":{"order":1,"group":"Messages & Bookings"}},
        label: ROUTE_NAME["/staff/messages"],
        description: "Messages people send through the Contact page on drmed.ph. Reply to them, book them an appointment, or close them. The number next to it counts the messages nobody has replied to yet.",
        roles: ["reception", "admin"],
      },
      {
        // Reception + admin only (owner decision 2026-09-24): medtech lost the
        // sidebar item, the lab dashboard shortcut, Cmd+K and the page itself.
        // Admin keeps the lab-dashboard shortcut. Sits with Messages & Bookings
        // (owner request 2026-09-24): quotes answer the same phone/website
        // inquiries those pages handle. Roles come from
        // QUICK_QUOTE_ROLES, the one list every doorway to /staff/quote uses.
        href: "/staff/quote",
        quicklink: {"reception":{"order":2,"group":"Messages & Bookings"},"lab":{"order":1,"roles":["admin"]}},
        label: ROUTE_NAME["/staff/quote"],
        description: "Build a price quote without creating a visit. Useful for phone inquiries: 'How much for a CBC + Urinalysis + Lipid panel?' Generates a shareable quote with HMO or cash pricing.",
        roles: QUICK_QUOTE_ROLES,
      },
    ],
  },
  {
    // Patients first, then the Reception Queue (owner request 2026-09-24).
    // The old Billing section's items follow below a divider (merged in
    // 2026-09-24): Visit Records, Cash Drawer.
    heading: "Front Desk",
    items: [
      {
        href: "/staff/patients",
        quicklink: {"reception":{"order":3,"group":"Front Desk"}},
        // Dashboard action/view owned here without adding a sidebar row.
        shortcuts: [{ href: "/staff/patients/new", label: ROUTE_NAME["/staff/patients/new"], roles: ["reception","admin"], quicklink: {"reception":{"order":4,"group":"Front Desk"}} }],
        label: ROUTE_NAME["/staff/patients"],
        // The default prefix match also covers /staff/patients/new — the
        // "New patient registration" sidebar item was removed in the 2026-09-15
        // cleanup, so this item is the one that stays lit on the form.
        description: "Search the patient database by name, contact number, or DRM ID. Open a patient to see their full visit history, attached IDs, contact info, and previous test results. Use the + New patient button at the top to register a brand-new patient.",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/visits/queue",
        quicklink: {"reception":{"order":5,"group":"Front Desk"}},
        label: ROUTE_NAME["/staff/visits/queue"],
        description: "Today's live front-desk worklist in three stages: Waiting for payment (record the payment), Processing (lab/imaging still working on results) and Completed (paid, nothing outstanding — print the patient's billing). Updates on its own as payments come in and tests finish.",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/visits",
        quicklink: {"reception":{"order":6,"group":"Front Desk"}},
        dividerBefore: true,
        label: ROUTE_NAME["/staff/visits"],
        // /staff/visits is the visit records page (every visit ever); each
        // visit opens to its printable A5 billing. "Visit Records" is the one
        // name for this route — the in-page tab and the reception dashboard
        // quicklink use it too, and the page's own h1 matches. excludePrefixes
        // keeps this item from lighting on /staff/visits/new (reached from the
        // Reception Queue's + New visit button, a patient page, or the Visits
        // tab bar — no sidebar item owns it) or /staff/visits/queue (the
        // Front Desk Reception Queue item owns that route).
        excludePrefixes: ["/staff/visits/new", "/staff/visits/queue"],
        description: "Every visit ever, searchable by date / patient / status. Open a visit to print its patient billing (A5) and re-issue receipts. This is the record side of billing — to start a new charge, use + New visit on the Reception Queue.",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/payments/cash-drawer",
        quicklink: {"reception":{"order":7,"group":"Front Desk"}},
        // Dashboard action/view owned here without adding a sidebar row.
        shortcuts: [{ href: "/staff/payments/petty-cash", label: ROUTE_NAME["/staff/payments/petty-cash"], roles: ["reception","admin"], quicklink: {"reception":{"order":8,"group":"Front Desk"}} }],
        // An umbrella: "Cash Drawer" names the whole till, while the landing tab
        // is "Cash In & Out" (the running balance and movement log) — naming the
        // item after that one tab would hide Petty Cash and End of Day.
        label: SECTION_NAME["/staff/payments/cash-drawer"],
        // One item for the whole till: lands on the Cash In & Out tab; Petty
        // Cash and End of Day are the other two tabs of the same page
        // (PaymentsTabs). activePrefixes keeps this item lit on both sibling
        // routes. NOT the /staff/payments parent — that would also light it on
        // /staff/payments/new (Record payment), which no sidebar item owns.
        activePrefixes: ["/staff/payments/petty-cash", "/staff/payments/eod"],
        description: "Your shift cash workspace, in three tabs. Cash In & Out: start your drawer with a counted amount of starting cash and record cash paid out. Petty Cash: log small cash expenses paid from the till (transport, courier, supplies, minor repairs) so the day's count still ties. End of Day: count the drawer again to see the difference. Anything paid by GCash, bank transfer, or a vendor invoice goes through admin.",
        roles: ["reception", "admin"],
      },
    ],
  },
  {
    heading: "Lab & Imaging",
    items: [
      {
        href: "/staff/queue",
        quicklink: {"lab":{"order":0}},
        label: "Queue",
        description: "The medtech / radtech / sonographer work queue. Shows every test that's been ordered, grouped by status: waiting (sample not yet collected), in-progress (running), sign-off pending, or released. Click a row to enter results. Reception sees only today's released results here, with a Print result button for the patient's copy.",
        // Reception is here for ONE tab: "Released today", to print the
        // patient's copy (owner decision 2026-09-24). The page redirects it
        // there and hides every bench tab and control.
        roles: ["medtech", "pathologist", "admin", "xray_technician", "reception"],
      },
      {
        href: "/staff/results",
        label: ROUTE_NAME["/staff/results"],
        description: "Archive of every result ever created or released — searchable by patient name, DRM-ID, or service. Filter by status (released / ready / in progress / cancelled) and date range. View the released PDF inline for review. Per partner policy, admins + medtechs can see all results.",
        roles: ["medtech", "pathologist", "admin", "xray_technician"],
      },
      {
        href: "/staff/critical-alerts",
        label: ROUTE_NAME["/staff/critical-alerts"],
        description: "Results that crossed a critical threshold (dangerously high or low values). Review each one, make the clinical follow-up call, then acknowledge it here so the whole team can see it's been handled.",
        roles: ["pathologist", "admin"],
      },
    ],
  },
  {
    heading: "Admin",
    items: [
      {
        href: "/staff/admin/accounting/hmo-claims",
        quicklink: {"admin":{"order":8}},
        label: ROUTE_NAME["/staff/admin/accounting/hmo-claims"],
        description: "Where you manage the entire HMO billing cycle: which patient visits still need to be invoiced, which invoices are awaiting payment, which HMOs are slow payers, and which to write off. Drill into a provider (e.g., Maxicare) to see every claim and its status.",
        roles: ["admin"],
      },
      {
        // Opens the section overview; the base href owns every AP descendant.
        href: "/staff/admin/accounting/ap",
        quicklink: {"admin":{"order":7,"routeName":true}},
        label: SECTION_NAME["/staff/admin/accounting/ap"],
        description: "Everything expense-related in one place. Use + Quick expense on the overview for already-paid same-day expenses (cash, GCash, owner OOP). Tabs inside: Overview (what's outstanding), Vendor Bills (invoices with due dates), Bill Payments (the outflows), Vendors (master list), Recurring Bills (monthly auto-bills).",
        roles: ["admin"],
      },
      {
        href: "/staff/admin/accounting/cogs/send-outs",
        label: ROUTE_NAME["/staff/admin/accounting/cogs/send-outs"],
        // Outside-Lab Performance lives UNDER this href
        // (…/send-outs/vendor-performance), so exclude it or both items light
        // at once on that page.
        excludePrefixes: ["/staff/admin/accounting/cogs/send-outs/vendor-performance"],
        description: "Costs for tests the clinic doesn't run in-house and sends to another lab (e.g. Hi Precision). Two tabs: Accrued (you billed the patient but the other lab's invoice isn't in yet) and True-ups (matching your estimate to the real bill once it arrives).",
        roles: ["admin"],
      },
      {
        href: "/staff/admin/accounting/cogs/send-outs/vendor-performance",
        label: ROUTE_NAME["/staff/admin/accounting/cogs/send-outs/vendor-performance"],
        description: "How each outside lab is doing: average cost per test, turnaround time, and how close your cost estimates were. Use it when deciding whether to switch outside labs or renegotiate rates.",
        roles: ["admin"],
      },
    ],
    subgroups: [
      {
        heading: "Pay Doctors",
        items: [
          {
            href: "/staff/admin/accounting/pf-payouts",
            quicklink: {"admin":{"order":3}},
            label: ROUTE_NAME["/staff/admin/accounting/pf-payouts"],
            description: "Pay each doctor their share of the consults they did (their professional fee). Ready to pay = ready now; Waiting on insurance = held until the HMO pays the clinic; Already paid = past payouts. Pick a doctor, send them the amount by GCash or cash, then record it here.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/pf-ytd-summary",
            label: ROUTE_NAME["/staff/admin/accounting/pf-ytd-summary"],
            description: "Per-doctor scoreboard for the year: how much each doctor earned, how much you've already paid out, and how much is still owed. Handy for year-end tax forms (BIR 2316 / 2307) and answering 'how much do we still owe Dr. X?'.",
            roles: ["admin"],
          },
        ],
      },
      {
        // Three groups split by dividers (2026-09-24): the pay cycle (Run
        // Payroll, Pay Periods) | staff records (Employees, Overtime, Leaves,
        // Cash Advances) | setup (Holidays, Government Rates, Settings).
        heading: "Payroll",
        items: [
          {
            href: "/staff/admin/payroll/runs",
            quicklink: {"admin":{"order":9}},
            label: ROUTE_NAME["/staff/admin/payroll/runs"],
            description: "The actual payroll computation for a given period — gross pay, overtime, deductions (SSS, PhilHealth, Pag-IBIG, withholding tax, loans), and net pay per employee. Reviewing the output and clicking 'Finalize' generates payslips and books the JE.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/periods",
            label: ROUTE_NAME["/staff/admin/payroll/periods"],
            description: "The semi-monthly pay cycles (1st-15th, 16th-end). Each period progresses through stages: open → cutoff → paid → locked. Lock a period after paying out so nobody adjusts past payroll by accident.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/employees",
            dividerBefore: true,
            label: ROUTE_NAME["/staff/admin/payroll/employees"],
            description: "Every paid employee (receptionists, medtechs, etc. — NOT the PF-paid doctors). Each profile has base salary, SSS/PhilHealth/Pag-IBIG ID numbers, tax info, and benefits. Add a new hire here before their first payroll.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/ot-slips",
            label: ROUTE_NAME["/staff/admin/payroll/ot-slips"],
            description: "Overtime hours submitted by employees that need admin approval before the next pay run. Approve here and the OT amount automatically flows into the payroll computation.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/leaves",
            label: ROUTE_NAME["/staff/admin/payroll/leaves"],
            description: "Tracks each employee's leave balance (vacation, sick, parental) and pending applications. Approve or reject leave requests here. Approved leave days affect pay computation automatically.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/reports/staff-advances",
            label: ROUTE_NAME["/staff/admin/reports/staff-advances"],
            description: "When staff borrow against future salary (cash advances, loans), the unpaid balance shows here. The next payroll auto-deducts toward repayment. Use to see who still owes what.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/holidays",
            dividerBefore: true,
            label: ROUTE_NAME["/staff/admin/payroll/holidays"],
            description: "Mark which Philippine holidays apply this year, and whether each is a regular holiday (200% pay if worked) or special non-working (130% pay if worked). The payroll engine uses this to compute holiday pay automatically.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/rates",
            label: ROUTE_NAME["/staff/admin/payroll/rates"],
            description: "The current government contribution tables — SSS, PhilHealth, Pag-IBIG, and BIR withholding tax brackets. Update these when the government issues new rate schedules (usually January 1).",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/settings",
            label: ROUTE_NAME["/staff/admin/payroll/settings"],
            description: "Global payroll configuration — pay cycle dates (e.g., pay on the 5th and 20th), minimum wage compliance threshold, default tax status, and 13th-month bonus settings.",
            roles: ["admin"],
          },
        ],
      },
      {
        heading: "Books & Reports",
        items: [
          {
            href: "/staff/admin/accounting/journal",
            quicklink: {"admin":{"order":4}},
            // The list page's "+ New journal entry" button reaches /journal/new,
            // so the manual-entry route no longer needs its own sidebar item.
            label: ROUTE_NAME["/staff/admin/accounting/journal"],
            description: "The full transaction log of the clinic — every revenue, expense, payment, and adjustment ever booked. Each entry has matching debits and credits that must balance. Search or filter by source to find an entry, or click + New journal entry to hand-post a correction, opening balance, or one-off the system didn't auto-book.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/financial-statements",
            quicklink: {"admin":{"order":1}},
            label: SECTION_NAME["/staff/admin/accounting/financial-statements"],
            // One tabbed page: Income Statement (P&L) / Balance Sheet / Cash
            // flow. href is the bare route (Income statement); the default
            // prefix match keeps it lit on the balance-sheet & cash-flow tabs.
            description: "The three core reports on one page, as tabs: Income Statement (P&L) — revenue minus expenses for a date range; Balance Sheet — what you own, owe, and the owner's equity on a date; Cash Flow — how cash actually moved. Pick a date range and switch tabs.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/variance",
            label: ROUTE_NAME["/staff/admin/accounting/variance"],
            description: "Set a monthly budget for each expense category (e.g., 'Salaries: ₱400K, Rent: ₱270K') then compare it to what actually happened. Highlights where you went over or under budget so you can investigate. Useful for spotting unusual spending early.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/bank-rec",
            label: ROUTE_NAME["/staff/admin/accounting/bank-rec"],
            description: "Cross-check the system's record of your bank account against the real bank statement. Upload the bank's CSV here — the system matches each transaction to a journal entry and flags anything that doesn't match (missing deposits, bank fees you forgot to book, etc.). Do this monthly to catch errors.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/periods",
            quicklink: {"admin":{"order":0}},
            label: ROUTE_NAME["/staff/admin/accounting/periods"],
            description: "Monthly accounting windows (Jan 2026, Feb 2026, etc.). After you finish closing the books for a month, lock it here so no one accidentally posts new entries into a finished period. The bookkeeper does this monthly, usually 15 days after month-end.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/accrual-templates",
            label: ROUTE_NAME["/staff/admin/accounting/accrual-templates"],
            description: "For expenses that happen every month on a predictable schedule (rent, internet, insurance), set up a template here once. The system auto-posts a draft entry on the chosen day each month — you just review and post. Saves repetitive typing.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/operations",
            dividerBefore: true,
            excludePrefixes: ["/staff/admin/operations/cron-health"],
            quicklink: {"admin":{"order":2}},
            // Dashboard action/view owned here without adding a sidebar row.
            shortcuts: [
              { href: "/staff/admin/operations/cash", label: ROUTE_NAME["/staff/admin/operations/cash"], roles: ["admin"], quicklink: { admin: { order: 5 } } },
              { href: "/staff/admin/operations/daily-revenue", label: ROUTE_NAME["/staff/admin/operations/daily-revenue"], roles: ["admin"], quicklink: { admin: { order: 6 } } },
            ],
            label: SECTION_NAME["/staff/admin/operations"],
            description: "The clinic's full operational day-by-day report (reproduces the manual DAILY MONITORING sheet): lab + consult by payment channel and HMO, distinct customers, discounts, gross profit, PF collected, and per-doctor / per-specialty productivity. Pick any month or custom date range; export to CSV.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/reports/lab-tat",
            label: ROUTE_NAME["/staff/admin/reports/lab-tat"],
            description: "Measures how long tests take to complete — from sample collection to result release. Broken down by test type. Use to spot bottlenecks (e.g., 'why are FBSs taking 3 hours when they should take 1?').",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/reports/stuck-tests",
            label: ROUTE_NAME["/staff/admin/reports/stuck-tests"],
            description: "Tests sitting too long in any non-final state — unclaimed, in progress, or ready but unreleased — so nothing silently stalls like Visit #0037 did.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/reports/undone-releases",
            label: ROUTE_NAME["/staff/admin/reports/undone-releases"],
            description: "Every result release that was withdrawn — who undid it, why, whether the patient had already seen it, and whether it has since been re-released or cancelled (RA 10173 oversight).",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/reports/deleted-entries",
            label: ROUTE_NAME["/staff/admin/reports/deleted-entries"],
            description: "Every visit or test deleted from the queues — who deleted it, why, what it was worth, and whether it was restored. Only unpaid entries can be deleted; paid ones need a payment deleted first.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/reports/payment-changes",
            label: ROUTE_NAME["/staff/admin/reports/payment-changes"],
            description: "Every payment that was deleted, edited (wrong method or amount) or moved to another visit — who changed it, when, why, and what it became. Use it to spot patterns, like one cashier fixing methods often.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/reports/patients-without-consent",
            label: ROUTE_NAME["/staff/admin/reports/patients-without-consent"],
            description: "Active patients with no data-privacy consent on file — clear this list before enabling the consent gate, or their releases will block.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting",
            label: ROUTE_NAME["/staff/admin/accounting"],
            description: "Status board for the daily export that pushes accounting data out to Google Sheets (where your external bookkeeper or auditor can pull it). Check here if the bookkeeper says they didn't get today's data — you can re-run a failed sync from this page.",
            exact: true,
            roles: ["admin"],
          },
        ],
      },
      {
        heading: "Operations",
        items: [
          {
            href: "/staff/admin/operations/cron-health",
            label: ROUTE_NAME["/staff/admin/operations/cron-health"],
            description: "Check when each scheduled task last ran and whether a run is overdue. Pending means its initial monitoring grace period has not ended.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/closures",
            label: ROUTE_NAME["/staff/admin/closures"],
            description: "Block specific dates from online booking — public holidays, staff retreats, equipment maintenance days. Patients trying to book those dates on the website will see them as unavailable.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/inventory",
            label: ROUTE_NAME["/staff/admin/inventory"],
            description: "Stock levels for consumables used in the lab and imaging — reagents, blood collection tubes, X-ray film, swabs, etc. Set a reorder threshold per item and the system warns you when you're running low.",
            roles: ["admin", "medtech", "xray_technician"],
          },
          {
            href: "/staff/admin/gift-codes",
            dividerBefore: true,
            label: ROUTE_NAME["/staff/admin/gift-codes"],
            description: "Every prepaid gift code ever sold (active, redeemed, expired), with the buyer and recipient details. Use to look up a specific code if a customer can't find theirs, or to track total outstanding gift-code liability.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/newsletter",
            label: ROUTE_NAME["/staff/admin/newsletter"],
            description: "Send email blasts to past patients (e.g., flu vaccine season reminder, new service announcement). Tracks who opened and clicked.",
            roles: ["admin"],
          },
          {
            // Lands on Ad performance (the bare base route); the default
            // prefix match keeps this item lit on the /ops tab too.
            href: "/staff/marketing",
            label: SECTION_NAME["/staff/marketing"],
            description: "The marketing workspace, in three tabs: Ad Performance (upload your Meta + Google ad CSV exports to see spend, cost per booking and the lead funnel, next to the real bookings and website messages each campaign brought in according to the clinic's records), Ops Tracker (daily/weekly/monthly checklists, the 12-week launch roadmap and the campaign status board), and Booking Sources (where appointments and website messages came from, by source and by ad campaign). Uploaded ad files and the Ops Tracker are saved in this browser only.",
            roles: ["admin"],
          },
        ],
      },
      {
        heading: "Catalog & Setup",
        items: [
          {
            href: "/staff/admin/prices",
            label: ROUTE_NAME["/staff/admin/prices"],
            description: "Set how much each test, package, vaccine, or imaging service costs. Update prices here when you raise rates or run a promo — the booking app and reception both pull from this list automatically.",
            roles: ["admin"],
          },
          {
            href: "/staff/services",
            label: ROUTE_NAME["/staff/services"],
            description: "The master catalog of everything the clinic offers — every lab test, package, consult, vaccine, and imaging study. For each one you set the regular price, HMO-discounted price, whether it's done in-house or sent to another lab (send-out), and which section handles it (chemistry, hematology, etc.).",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/discounts",
            label: ROUTE_NAME["/staff/admin/discounts"],
            description: "The discounts reception can apply per line on a new visit — add your own (percent off or a fixed peso amount), rename, or retire them. Senior / PWD is statutory: fixed at 20% by law and always available.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/result-templates",
            quicklink: {"lab":{"order":2,"roles":["admin"]}},
            label: ROUTE_NAME["/staff/admin/result-templates"],
            description: "The blueprints behind every lab result PDF. For each test, you set up the parameters (e.g., for a CBC: WBC, RBC, hemoglobin) and the normal/abnormal reference ranges by age and sex. Edit a template here when a manufacturer changes the reference range or you add a new test.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/hmo-providers",
            label: ROUTE_NAME["/staff/admin/hmo-providers"],
            description: "The list of HMO companies the clinic accepts (Maxicare, Intellicare, Etiqa, Cocolife, etc.) with their billing thresholds and contact info. Add a new provider here when you start accepting a new HMO.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/physicians",
            label: ROUTE_NAME["/staff/admin/physicians"],
            description: "Every doctor who works at the clinic — for consultations, procedures, or signing off lab results. Tracks their PRC license, signature image (for results), and how they get paid: PF split (the doctor takes a cut of each consult), rent-paying (they pay the clinic, keep the rest), or shareholder.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/chart-of-accounts",
            dividerBefore: true,
            label: ROUTE_NAME["/staff/admin/accounting/chart-of-accounts"],
            description: "Master list of every 'bucket' your money lives in: Cash on Hand, BPI, BDO, GCash, Accounts Receivable, Revenue, Rent expense, etc. Each bucket has a 4-digit code. Add a new account when you open a new bank, start using a new wallet (Maya), or need to track a new kind of expense.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/money-routing",
            label: ROUTE_NAME["/staff/admin/accounting/money-routing"],
            description: "The rules that decide which account each payment and cash-drawer entry is recorded in — for example GCash payments go to 1030 GCash Wallet and cash payments to 1010 Cash on Hand. Also sets the drawer's daily starting cash. Change only when you switch banks or add a payment method.",
            roles: ["admin"],
          },
        ],
      },
      {
        heading: "Admin Tools",
        items: [
          {
            href: "/staff/users",
            label: ROUTE_NAME["/staff/users"],
            description: "Create new staff logins, change roles (reception/medtech/pathologist/admin/xray), reset passwords, and deactivate former employees. Each user maps to one role with specific page access.",
            roles: ["admin"],
          },
          {
            href: "/staff/audit",
            label: ROUTE_NAME["/staff/audit"],
            description: "Searchable record of every meaningful action in the system — who logged in, who released a result, who voided a payment, who marked a claim paid. Filter by user, action type, or date. Essential for compliance reviews.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/emails-sent",
            label: ROUTE_NAME["/staff/admin/emails-sent"],
            description: "Every transactional email the system sent — result alerts, booking confirmations, day-before reminders, newsletters, and registration welcomes. Filter by type, status, date, or patient; export to CSV.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/settings/dashboard-cards",
            dividerBefore: true,
            label: ROUTE_NAME["/staff/admin/settings/dashboard-cards"],
            description: "Pick which summary cards (today's revenue, pending releases, low inventory, etc.) appear on each role's home dashboard. Different roles see different cards by default.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/seo",
            label: ROUTE_NAME["/staff/admin/seo"],
            description: "Push new or changed pages to Bing, Yandex and other IndexNow engines for faster indexing, and re-submit the whole site after setup or a content update. (Google indexes via the sitemap, not IndexNow.)",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/settings/consent-gate",
            label: ROUTE_NAME["/staff/admin/settings/consent-gate"],
            description: "Turn the RA 10173 data-privacy consent requirement on or off. When ON, lab results can't be released for a patient without consent on file. Ships OFF — flip it on once reception is briefed.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/settings/online-booking",
            label: ROUTE_NAME["/staff/admin/settings/online-booking"],
            description: "Pause or resume patient self-booking on the website and in the patient portal. While paused, patients see a notice to call, text, or message reception instead; reception can still book them from Appointments. Add an optional note, such as when booking will be back.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/settings/alerts",
            label: ROUTE_NAME["/staff/admin/settings/alerts"],
            description: "Choose who gets the clinic's alert emails — new website messages, result-template problems and possible duplicate patients. Switch each alert on or off, pick staff one by one, or add a shared inbox.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/import-patients",
            dividerBefore: true,
            label: ROUTE_NAME["/staff/admin/import-patients"],
            description: "Bulk-import patients from a CSV file — used during initial setup or when migrating from another system. Reads name, DOB, phone, email columns and creates one patient record per row.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/patient-merge",
            label: ROUTE_NAME["/staff/admin/patient-merge"],
            description: "When the same person was accidentally registered twice (different spellings, different contact numbers), combine the two records into one. Visit history from both gets merged onto the surviving record.",
            roles: ["admin"],
          },
        ],
      },
    ],
  },
  {
    heading: "Personal",
    items: [
      {
        href: "/staff/profile",
        label: ROUTE_NAME["/staff/profile"],
        roles: ["reception", "medtech", "pathologist", "admin", "xray_technician"],
      },
      {
        // Moved out of "Hidden Tabs" when that section went admin-only
        // (partner revision 8): payslips are self-service for EVERY role, so
        // they belong in the per-user Personal section, not the parked one.
        href: "/staff/payslips",
        label: ROUTE_NAME["/staff/payslips"],
        description: "Your own payslip history — open a pay period to see gross pay, overtime, deductions (SSS, PhilHealth, Pag-IBIG, tax, loans) and net pay, and download the PDF.",
        roles: ["reception", "medtech", "pathologist", "admin", "xray_technician"],
      },
    ],
  },
  {
    // Top-level "parked" section — real, reachable pages that are deliberately
    // de-emphasized: either not part of the live workflow yet (Sign-off,
    // Patient receivables) or moved off the everyday nav per partner feedback
    // (Sell gift code, Registration link).
    //
    // Partner revision 8: the section is now ADMIN-ONLY and collapsed by
    // default, so day-to-day roles never see the parked clutter. Two items
    // moved OUT first so nobody lost access to something they need — Cash
    // drawer back to Front Desk (revisions 2/9) and My payslips to Personal
    // (all roles draw a payslip). Everything left here is admin housekeeping.
    heading: "Hidden Tabs",
    adminOnly: true,
    collapsible: true,
    items: [
      {
        href: "/staff/gift-codes/sell",
        quicklink: {"reception":{"order":9,"group":"Front Desk"}},
        label: ROUTE_NAME["/staff/gift-codes/sell"],
        description: "Sell a prepaid gift code to a customer — they pay now, the recipient redeems later for services. Generates a printable code with QR + expiration date. Parked here for now; reception sells these rarely.",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/gift-codes/refund",
        label: ROUTE_NAME["/staff/gift-codes/refund"],
        description: "Undo a mis-keyed gift-code sale — wrong buyer details, wrong payment method, customer changed their mind — while the code is still unused. Reverses the payment and puts the code back on sale; a code already redeemed on a visit needs the payment void instead.",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/registration",
        label: ROUTE_NAME["/staff/registration"],
        description: "Share the public pre-registration page with patients — show the QR to scan, copy the link to text them, or print a desk poster. Parked here because registration is optional; it just saves counter time on arrival.",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/signoff",
        label: ROUTE_NAME["/staff/signoff"],
        description: "Pathologist review queue — tests that the medtech finished but need the pathologist's final review and signature before release. Hidden from the main Lab section because pathologist review isn't yet part of the live workflow; surface here for testing or when the role goes active.",
        roles: ["pathologist", "admin"],
      },
      {
        href: "/staff/admin/accounting/patient-ar",
        label: ROUTE_NAME["/staff/admin/accounting/patient-ar"],
        description: "Cash patients with unpaid balances. Hidden from the main Admin section because the clinic uses all-or-nothing payments (no partial / no HMO co-pay) so this list is almost always empty. Re-surface if partial payments or co-pay are introduced.",
        roles: ["admin"],
      },
    ],
  },
];

// Filters items + subgroups inside each section by role, drops empty
// subgroups, then drops sections that ended up with no visible content.
// A section may carry items, subgroups, or both — preserves whichever
// has content for the renderer. `adminOnly` sections are dropped wholesale
// for non-admins regardless of what their items' own roles say; `collapsible`
// is carried through so the renderer knows to wrap the section in <details>.
export function visibleNavFor(role: StaffRole): StaffNavSection[] {
  const filtered: StaffNavSection[] = [];
  for (const section of STAFF_NAV) {
    if (section.adminOnly && role !== "admin") continue;
    const items = section.items
      ? section.items.filter((i) => i.roles.includes(role))
      : [];
    const subgroups = section.subgroups
      ? section.subgroups
          .map((g) => ({
            heading: g.heading,
            items: g.items.filter((i) => i.roles.includes(role)),
          }))
          .filter((g) => g.items.length > 0)
      : [];
    if (items.length === 0 && subgroups.length === 0) continue;
    filtered.push({
      heading: section.heading,
      ...(items.length > 0 ? { items } : {}),
      ...(subgroups.length > 0 ? { subgroups } : {}),
      ...(section.collapsible ? { collapsible: true } : {}),
      ...(section.adminOnly ? { adminOnly: true } : {}),
    });
  }
  return filtered;
}

export function isItemActive(item: StaffNavItem, pathname: string): boolean {
  if (item.exact) return pathname === item.href;
  if (
    item.excludePrefixes?.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`),
    )
  ) {
    return false;
  }
  if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return true;
  return (
    item.activePrefixes?.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`),
    ) ?? false
  );
}

// True if any item in the subgroup matches the current path. Drives
// the auto-expand behavior so the user's current location is always
// visible without an extra click.
export function isSubgroupActive(
  subgroup: StaffNavSubgroup,
  pathname: string,
): boolean {
  return subgroup.items.some((item) => isItemActive(item, pathname));
}

// Same idea one level up: true if the current path lives anywhere inside the
// section (flat items or nested subgroups). Drives auto-expand for
// `collapsible` sections so a collapsed-by-default section still opens itself
// when the user is on one of its pages.
export function isSectionActive(
  section: StaffNavSection,
  pathname: string,
): boolean {
  return (
    (section.items?.some((item) => isItemActive(item, pathname)) ?? false) ||
    (section.subgroups?.some((g) => isSubgroupActive(g, pathname)) ?? false)
  );
}

/** Dashboard inclusion is independent of sidebar parking (Sell Gift Code is
 * intentionally a reception shortcut in an admin-only Hidden Tabs section).
 * Item roles still gate access; the audience and order preserve each dashboard. */
export function quickLinksFor(role: StaffRole, audience: DashboardAudience) {
  const links: { item: StaffNavItem; order: number; group: string; routeName?: boolean }[] = [];
  function collect(item: StaffNavItem, heading: string) {
    const config = item.quicklink?.[audience];
    if (config && item.roles.includes(role) && (!config.roles || config.roles.includes(role))) {
      links.push({ item, ...config, group: config.group ?? heading });
    }
    item.shortcuts?.forEach((child) => collect(child, heading));
  }
  for (const section of STAFF_NAV) {
    section.items?.forEach((item) => collect(item, section.heading));
    section.subgroups?.forEach((group) => group.items.forEach((item) => collect(item, section.heading)));
  }
  return links.sort((a, b) => a.order - b.order).map(({ item, group, routeName }) => ({
    ...item, label: routeName ? ROUTE_NAME[item.href] : item.label, group,
  }));
}

/** Badge count for one item, keyed by href. Defaults to 0 when no map or no entry. */
export function itemBadgeCount(
  item: StaffNavItem,
  badges?: Record<string, number>,
): number {
  return badges?.[item.href] ?? 0;
}

/** Sum of every item's badge in a subgroup — shown on its `<summary>` so the
 * total is visible even while the subgroup is collapsed. */
export function subgroupBadgeTotal(
  group: StaffNavSubgroup,
  badges?: Record<string, number>,
): number {
  return group.items.reduce((sum, item) => sum + itemBadgeCount(item, badges), 0);
}

/** Sum of every item's badge across a whole section (flat items + subgroups) —
 * shown on a `collapsible` section's `<summary>` for the same reason. */
export function sectionBadgeTotal(
  section: StaffNavSection,
  badges?: Record<string, number>,
): number {
  const itemsTotal =
    section.items?.reduce((sum, item) => sum + itemBadgeCount(item, badges), 0) ?? 0;
  const subgroupsTotal =
    section.subgroups?.reduce((sum, g) => sum + subgroupBadgeTotal(g, badges), 0) ?? 0;
  return itemsTotal + subgroupsTotal;
}

export function quickLinkGroupsFor(role: StaffRole, audience: DashboardAudience) {
  const groups = new Map<string, ReturnType<typeof quickLinksFor>>();
  for (const item of quickLinksFor(role, audience)) {
    const items = groups.get(item.group) ?? [];
    items.push(item);
    groups.set(item.group, items);
  }
  return [...groups].map(([label, items]) => ({ label, items }));
}
