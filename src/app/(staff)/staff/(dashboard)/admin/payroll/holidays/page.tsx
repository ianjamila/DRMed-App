import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import { HolidaysClient, type HolidayRow } from "./holidays-client";

export const metadata = { title: "Holidays — payroll admin" };
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function PayrollHolidaysPage({ searchParams }: PageProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const todayManila = todayManilaISODate();
  const currentYear = Number.parseInt(todayManila.slice(0, 4), 10);

  // Loosely validate the ?year= param. Anything implausible falls back to
  // the current Manila year so a junk query string can't break the page.
  const yearParam = sp.year ? Number.parseInt(sp.year, 10) : currentYear;
  const year =
    Number.isFinite(yearParam) && yearParam >= 1900 && yearParam <= 2999
      ? yearParam
      : currentYear;

  // payroll_holidays.date is a plain DATE column, so YYYY-MM-DD bounds
  // compare correctly. We pull both active and inactive rows because the
  // admin needs visibility into soft-disabled holidays.
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year + 1}-01-01`;

  // Service-role client: the page is gated by requireAdminStaff() above,
  // and a single tabular admin view is easier to maintain without
  // wrestling RLS for every read.
  const admin = createAdminClient();

  let dbError: string | null = null;
  const { data: rows, error } = await admin
    .from("payroll_holidays")
    .select("id, date, kind, name, notes, is_active, created_at, updated_at")
    .gte("date", yearStart)
    .lt("date", yearEnd)
    .order("date", { ascending: true });
  if (error) {
    console.error("[payroll/holidays] holidays query failed:", error);
    dbError = "Failed to load holidays.";
  }

  const holidays: HolidayRow[] = (rows ?? []).map((row) => ({
    id: row.id,
    date: row.date,
    kind: row.kind,
    name: row.name,
    notes: row.notes,
    is_active: row.is_active,
  }));

  // Synthetic 4-year window centred on "now" so the admin can flip between
  // adjacent years quickly. Always include `year` itself so a hand-typed
  // ?year=... outside the window remains a valid option in the dropdown.
  const yearsSet = new Set<number>([
    currentYear - 1,
    currentYear,
    currentYear + 1,
    currentYear + 2,
    year,
  ]);
  const years = Array.from(yearsSet).sort((a, b) => a - b);

  // Default the "Add holiday" date to today only if no row exists for that
  // day yet — otherwise leave it blank so the admin picks a date explicitly.
  const todayAlreadyUsed = holidays.some((h) => h.date === todayManila);
  const defaultAddDate = todayAlreadyUsed ? "" : todayManila;

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Holidays
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Public holidays used by the payroll compute engine. Regular holidays
          trigger the 200% pay multiplier; special non-working days trigger
          130%.
        </p>
      </header>

      <HolidaysClient
        holidays={holidays}
        years={years}
        currentYear={year}
        defaultAddDate={defaultAddDate}
        error={dbError}
      />
    </div>
  );
}
