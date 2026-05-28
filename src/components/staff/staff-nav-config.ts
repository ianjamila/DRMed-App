// Sidebar nav items and which roles can see each.
// Used by StaffShell to render a role-filtered list.

import type { StaffSession } from "@/lib/auth/require-staff";

export type StaffRole = StaffSession["role"];

export interface StaffNavItem {
  href: string;
  label: string;
  // Plain-English description shown as a hover tooltip + small info icon. Use
  // it for any item whose name involves jargon (accounting terms, abbreviations,
  // domain shorthand). Skip for items whose label is already self-explanatory
  // (e.g. "Patients", "Appointments", "My profile").
  description?: string;
  // The current path is "active" if it equals href OR starts with `${href}/`.
  // Override with a custom matcher when needed (e.g. /staff is too broad).
  exact?: boolean;
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
};

export const STAFF_NAV: StaffNavSection[] = [
  {
    heading: "Overview",
    items: [
      {
        href: "/staff",
        label: "Dashboard",
        exact: true,
        roles: ["reception", "medtech", "pathologist", "admin", "xray_technician"],
      },
    ],
  },
  {
    heading: "Reception",
    items: [
      {
        href: "/staff/appointments",
        label: "Appointments",
        description: "Today's scheduled patients and walk-in slots. Mark patients arrived to start their visit, or reschedule no-shows. View other days using the date picker.",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/patients",
        label: "Patients",
        description: "Search the patient database by name, contact number, or DRM ID. Open a patient to see their full visit history, attached IDs, contact info, and previous test results.",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/visits",
        label: "Visits",
        description: "Today's and historic patient visits. The Archive tab is a searchable list of every visit ever (filter by date / patient / status). The New visit tab starts a new one — pick the patient (or register new), pick services, route to lab/imaging/consult.",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/quote",
        label: "Quick quote",
        description: "Build a price quote without creating a visit. Useful for phone inquiries: 'How much for a CBC + Urinalysis + Lipid panel?' Generates a shareable quote with HMO or cash pricing.",
        roles: ["reception", "medtech", "admin"],
      },
      {
        href: "/staff/inquiries",
        label: "Inquiries",
        description: "Inquiries that came in through the website chat or Messenger but haven't been converted into a real appointment yet. Follow up here to book them or close the thread.",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/gift-codes/sell",
        label: "Sell gift code",
        description: "Sell a prepaid gift code to a customer — they pay now, the recipient redeems later for services. Generates a printable code with QR + expiration date.",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/payments/cash-drawer",
        label: "Cash drawer",
        description: "Your active shift workspace. Record the starting cash float when you open up, see every payment collected during the shift, and track the running total in the till.",
        roles: ["reception", "admin"],
      },
      {
        href: "/staff/payments/eod",
        label: "End of day",
        description: "Close out at the end of your shift: count the physical cash in the drawer, compare it to what the system says you should have, and explain any over/short. Locks the day once balanced.",
        roles: ["reception", "admin"],
      },
    ],
  },
  {
    heading: "Lab",
    items: [
      {
        href: "/staff/queue",
        label: "Queue",
        description: "The medtech / radtech / sonographer work queue. Shows every test that's been ordered, grouped by status: waiting (sample not yet collected), in-progress (running), sign-off pending, or released. Click a row to enter results.",
        roles: ["medtech", "pathologist", "admin", "xray_technician"],
      },
      {
        href: "/staff/signoff",
        label: "Sign-off",
        description: "Pathologist review queue — tests that the medtech finished but need the pathologist's final review and signature before the patient gets the result. The pathologist's e-signature is embedded on the PDF on release.",
        roles: ["pathologist", "admin"],
      },
    ],
  },
  {
    heading: "Admin",
    items: [
      {
        href: "/staff/admin/accounting/hmo-claims",
        label: "HMO claims",
        description: "Where you manage the entire HMO billing cycle: which patient visits still need to be invoiced, which invoices are awaiting payment, which HMOs are slow payers, and which to write off. Drill into a provider (e.g., Maxicare) to see every claim and its status.",
        roles: ["admin"],
      },
      {
        href: "/staff/admin/accounting/ap",
        label: "Expenses",
        description: "Everything expense-related in one place. Tabs inside: Quick expense (already-paid same-day expenses — cash, GCash, owner OOP), Overview (what's outstanding), Vendor bills (invoices with due dates), Bill payments (the outflows), Vendors (master list), Recurring (monthly auto-bills).",
        roles: ["admin"],
      },
    ],
    subgroups: [
      {
        heading: "Doctor PF & payroll",
        items: [
          {
            href: "/staff/admin/accounting/pf-payouts",
            label: "Doctor PF payouts",
            description: "Manages the professional fees the clinic owes each doctor (their cut of consultations they performed). Shows: Open (accrued but not yet paid), Pending HMO (waiting on HMO settlement before paying the doc), and History. Click a doctor to cut a payout — the system books the JE and prints a payout slip.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/pf-ytd-summary",
            label: "Doctor PF year-to-date",
            description: "Per-doctor scoreboard: total PF earned this year so far, total already paid out, and how much is still owed. Useful for year-end tax reporting (BIR 2316 for employed doctors, 2307 for PF-paid doctors) and answering 'how much do we still owe Dr. X?'.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/cogs/send-outs",
            label: "Lab send-out costs",
            description: "When the clinic doesn't run a test in-house and sends the sample to Hi Precision (or another lab) the cost is tracked here. Two tabs: Accrued (we billed the patient but haven't received the Hi Precision invoice yet) and True-ups (matching our estimate to the actual bill once it arrives).",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/cogs/send-outs/vendor-performance",
            label: "Send-out vendor scorecard",
            description: "Performance metrics by send-out lab: average cost per test, turnaround time, accuracy of cost estimates. Use this when deciding whether to switch send-out providers or renegotiate rates with your current one.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/runs",
            label: "Pay runs",
            description: "The actual payroll computation for a given period — gross pay, overtime, deductions (SSS, PhilHealth, Pag-IBIG, withholding tax, loans), and net pay per employee. Reviewing the output and clicking 'Finalize' generates payslips and books the JE.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/periods",
            label: "Pay periods",
            description: "The semi-monthly pay cycles (1st-15th, 16th-end). Each period progresses through stages: open → cutoff → paid → locked. Lock a period after paying out so nobody adjusts past payroll by accident.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/employees",
            label: "Employees",
            description: "Every paid employee (receptionists, medtechs, etc. — NOT the PF-paid doctors). Each profile has base salary, SSS/PhilHealth/Pag-IBIG ID numbers, tax info, and benefits. Add a new hire here before their first payroll.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/ot-slips",
            label: "Overtime slips",
            description: "Overtime hours submitted by employees that need admin approval before the next pay run. Approve here and the OT amount automatically flows into the payroll computation.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/leaves",
            label: "Leaves",
            description: "Tracks each employee's leave balance (vacation, sick, parental) and pending applications. Approve or reject leave requests here. Approved leave days affect pay computation automatically.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/holidays",
            label: "Holidays",
            description: "Mark which Philippine holidays apply this year, and whether each is a regular holiday (200% pay if worked) or special non-working (130% pay if worked). The payroll engine uses this to compute holiday pay automatically.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/rates",
            label: "Statutory rates",
            description: "The current government contribution tables — SSS, PhilHealth, Pag-IBIG, and BIR withholding tax brackets. Update these when the government issues new rate schedules (usually January 1).",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/payroll/settings",
            label: "Payroll settings",
            description: "Global payroll configuration — pay cycle dates (e.g., pay on the 5th and 20th), minimum wage compliance threshold, default tax status, and 13th-month bonus settings.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/reports/staff-advances",
            label: "Staff advances",
            description: "When staff borrow against future salary (cash advances, loans), the unpaid balance shows here. The next payroll auto-deducts toward repayment. Use to see who still owes what.",
            roles: ["admin"],
          },
        ],
      },
      {
        heading: "Books & reports",
        items: [
          {
            href: "/staff/admin/accounting/journal",
            label: "Journal entries",
            description: "The full transaction log of the clinic — every revenue, expense, payment, and adjustment ever booked. Each entry has matching debits and credits that must balance. Use the search to find a specific entry or filter by source (sale, payment, manual correction, etc.).",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/journal/new",
            label: "Manual journal entry",
            description: "Hand-post an accounting entry yourself. Use this for corrections, opening balances, or one-off items the system didn't auto-book (e.g., recording an owner's capital injection, or correcting a miscategorized expense). Every entry must balance: total debits = total credits.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/financial-statements",
            label: "Income statement (P&L)",
            description: "Profit & Loss report for any date range you pick. Shows total revenue (what you earned) minus total expenses (what you spent) = net income (your profit or loss). Pick last month to see how you did, or YTD for the year so far.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/financial-statements/balance-sheet",
            label: "Balance sheet",
            description: "A snapshot of the clinic's financial position on any date you pick. Shows what you OWN (cash, AR, equipment), what you OWE (vendor bills, doctor PFs, taxes), and the owner's equity. Asset total must equal Liabilities + Equity — if it doesn't, the books are out of balance.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/financial-statements/cash-flow",
            label: "Cash flow",
            description: "Tracks how cash physically moved during a date range — what came in (sales, HMO settlements) vs. what went out (rent, salaries, supplies). Different from the income statement because it ignores non-cash items and shows the actual bank/cash balance change.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/variance",
            label: "Budget vs actual",
            description: "Set a monthly budget for each expense category (e.g., 'Salaries: ₱400K, Rent: ₱270K') then compare it to what actually happened. Highlights where you went over or under budget so you can investigate. Useful for spotting unusual spending early.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/bank-rec",
            label: "Bank reconciliation",
            description: "Cross-check the system's record of your bank account against the real bank statement. Upload the bank's CSV here — the system matches each transaction to a journal entry and flags anything that doesn't match (missing deposits, bank fees you forgot to book, etc.). Do this monthly to catch errors.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/periods",
            label: "Monthly periods",
            description: "Monthly accounting windows (Jan 2026, Feb 2026, etc.). After you finish closing the books for a month, lock it here so no one accidentally posts new entries into a finished period. The bookkeeper does this monthly, usually 15 days after month-end.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/accrual-templates",
            label: "Recurring monthly entries",
            description: "For expenses that happen every month on a predictable schedule (rent, internet, insurance), set up a template here once. The system auto-posts a draft entry on the chosen day each month — you just review and post. Saves repetitive typing.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/reports/daily-revenue",
            label: "Daily revenue",
            description: "How much the clinic billed each day, broken down by service type (lab vs. consult vs. imaging) and payment method (cash, GCash, HMO, etc.). Use to spot trends or compare days/weeks.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/reports/lab-tat",
            label: "Lab turnaround time",
            description: "Measures how long tests take to complete — from sample collection to result release. Broken down by test type. Use to spot bottlenecks (e.g., 'why are FBSs taking 3 hours when they should take 1?').",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting",
            label: "External sync status",
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
            href: "/staff/admin/closures",
            label: "Closures",
            description: "Block specific dates from online booking — public holidays, staff retreats, equipment maintenance days. Patients trying to book those dates on the website will see them as unavailable.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/inventory",
            label: "Inventory",
            description: "Stock levels for consumables used in the lab and imaging — reagents, blood collection tubes, X-ray film, swabs, etc. Set a reorder threshold per item and the system warns you when you're running low.",
            roles: ["admin", "medtech", "xray_technician"],
          },
          {
            href: "/staff/admin/gift-codes",
            label: "Gift codes",
            description: "Every prepaid gift code ever sold (active, redeemed, expired), with the buyer and recipient details. Use to look up a specific code if a customer can't find theirs, or to track total outstanding gift-code liability.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/newsletter",
            label: "Newsletter",
            description: "Send email blasts to past patients (e.g., flu vaccine season reminder, new service announcement). Tracks who opened and clicked.",
            roles: ["admin"],
          },
        ],
      },
      {
        heading: "Catalog & setup",
        items: [
          {
            href: "/staff/admin/prices",
            label: "Prices",
            description: "Set how much each test, package, vaccine, or imaging service costs. Update prices here when you raise rates or run a promo — the booking app and reception both pull from this list automatically.",
            roles: ["admin"],
          },
          {
            href: "/staff/services",
            label: "Services",
            description: "The master catalog of everything the clinic offers — every lab test, package, consult, vaccine, and imaging study. For each one you set the regular price, HMO-discounted price, whether it's done in-house or sent to another lab (send-out), and which section handles it (chemistry, hematology, etc.).",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/result-templates",
            label: "Result templates",
            description: "The blueprints behind every lab result PDF. For each test, you set up the parameters (e.g., for a CBC: WBC, RBC, hemoglobin) and the normal/abnormal reference ranges by age and sex. Edit a template here when a manufacturer changes the reference range or you add a new test.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/hmo-providers",
            label: "HMO providers",
            description: "The list of HMO companies the clinic accepts (Maxicare, Intellicare, Etiqa, Cocolife, etc.) with their billing thresholds and contact info. Add a new provider here when you start accepting a new HMO.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/physicians",
            label: "Physicians",
            description: "Every doctor who works at the clinic — for consultations, procedures, or signing off lab results. Tracks their PRC license, signature image (for results), and how they get paid: PF split (the doctor takes a cut of each consult), rent-paying (they pay the clinic, keep the rest), or shareholder.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/chart-of-accounts",
            label: "Chart of accounts",
            description: "Master list of every 'bucket' your money lives in: Cash on Hand, BPI, BDO, GCash, Accounts Receivable, Revenue, Rent expense, etc. Each bucket has a 4-digit code. Add a new account when you open a new bank, start using a new wallet (Maya), or need to track a new kind of expense.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/payment-routing",
            label: "Payment routing",
            description: "The rules that tell the system 'when reception accepts payment via X, book it to account Y.' For example: GCash payments → 1030 GCash Wallet, Cheques → 1020 BPI, Cash → 1010 Cash on Hand. Edit if you switch banks or add a new payment method.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/accounting/cash-routing",
            label: "Cash routing",
            description: "Tracks the journey of physical cash from the moment a patient pays at reception, through the end-of-day count, to the bank deposit. Helps make sure no cash 'disappears' between collection and deposit.",
            roles: ["admin"],
          },
        ],
      },
      {
        heading: "Admin tools",
        items: [
          {
            href: "/staff/users",
            label: "Staff users",
            description: "Create new staff logins, change roles (reception/medtech/pathologist/admin/xray), reset passwords, and deactivate former employees. Each user maps to one role with specific page access.",
            roles: ["admin"],
          },
          {
            href: "/staff/audit",
            label: "Audit log",
            description: "Searchable record of every meaningful action in the system — who logged in, who released a result, who voided a payment, who marked a claim paid. Filter by user, action type, or date. Essential for compliance reviews.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/settings/dashboard-cards",
            label: "Dashboard settings",
            description: "Pick which summary cards (today's revenue, pending releases, low inventory, etc.) appear on each role's home dashboard. Different roles see different cards by default.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/import-patients",
            label: "Import patients",
            description: "Bulk-import patients from a CSV file — used during initial setup or when migrating from another system. Reads name, DOB, phone, email columns and creates one patient record per row.",
            roles: ["admin"],
          },
          {
            href: "/staff/admin/patient-merge",
            label: "Merge duplicate patients",
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
        label: "My profile",
        roles: ["reception", "medtech", "pathologist", "admin", "xray_technician"],
      },
      {
        href: "/staff/payslips",
        label: "My payslips",
        description: "Your own payslip history.",
        roles: ["reception", "medtech", "pathologist", "admin", "xray_technician"],
      },
    ],
  },
];

// Filters items + subgroups inside each section by role, drops empty
// subgroups, then drops sections that ended up with no visible content.
// A section may carry items, subgroups, or both — preserves whichever
// has content for the renderer.
export function visibleNavFor(role: StaffRole): StaffNavSection[] {
  const filtered: StaffNavSection[] = [];
  for (const section of STAFF_NAV) {
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
    });
  }
  return filtered;
}

export function isItemActive(item: StaffNavItem, pathname: string): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
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
