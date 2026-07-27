import Link from "next/link";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { isISODate, todayManilaISODate } from "@/lib/dates/manila";
import { VisitsTabs } from "./_components/visits-tabs";
import { paymentStatusLabel } from "@/lib/ui/payment-status";
import { formatPatientName } from "@/lib/patients/format-name";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/staff/page-header";
import { sectionTabClass } from "@/components/staff/section-tabs-style";
import {
  classesForKinds,
  classifyKind,
  combinePaymentStatus,
  foldVisitGroups,
  isVisitClass,
  kindPredicateFor,
  VISIT_CLASSES,
  VISIT_CLASS_LABEL,
  type VisitClass,
} from "@/lib/visits/classification";

export const metadata = {
  title: "Visits — staff",
};

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

const STATUS_BADGE: Record<string, string> = {
  paid: "bg-green-50 text-green-700 border-green-200",
  partial: "bg-amber-50 text-amber-700 border-amber-200",
  unpaid: "bg-red-50 text-red-700 border-red-200",
  waived: "bg-blue-50 text-blue-700 border-blue-200",
};

// Classification badges deliberately avoid green/amber/red/blue — those read
// as payment status one column over.
const CLASS_BADGE: Record<VisitClass, string> = {
  lab: "border-sky-200 bg-sky-50 text-sky-800",
  consult: "border-violet-200 bg-violet-50 text-violet-800",
  procedure: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-800",
};

const PAGE_SIZE = 25;

interface SearchProps {
  searchParams: Promise<{
    start?: string;
    end?: string;
    page?: string;
    kind?: string;
  }>;
}

/** One visit as fetched — the archive folds these into encounter rows. */
type VisitRow = {
  id: string;
  visit_number: string;
  visit_date: string;
  created_at: string;
  visit_group_id: string | null;
  payment_status: string;
  total_php: number;
  paid_php: number;
  patients: {
    id: string;
    drm_id: string;
    first_name: string;
    middle_name: string | null;
    last_name: string;
  };
  payments:
    | {
        method: string | null;
        voided_at: string | null;
      }[]
    | null;
};

type LineRow = {
  visit_id: string;
  services: { kind: string } | { kind: string }[] | null;
};

// The visit columns every query in this file selects. Test lines are NOT
// embedded here — they come from one flat query keyed on visit_id, so the
// kind-filtered page query can use `test_requests!inner` purely as a
// predicate without also truncating the lines each row displays.
const VISIT_SELECT = `
  id, visit_number, visit_date, created_at, visit_group_id,
  payment_status, total_php, paid_php,
  patients!inner ( id, drm_id, first_name, middle_name, last_name ),
  payments ( method, voided_at )
`;

function methodsFor(payments: VisitRow["payments"]): string {
  if (!payments || payments.length === 0) return "—";
  const methods = new Set<string>();
  for (const p of payments) {
    if (p.voided_at !== null) continue;
    if (p.method) methods.add(p.method);
  }
  if (methods.size === 0) return "—";
  return Array.from(methods).join(", ");
}

function kindOf(line: LineRow): string {
  const svc = Array.isArray(line.services) ? line.services[0] : line.services;
  return svc?.kind ?? "";
}

function visitNo(n: string): string {
  return `#${String(n).padStart(4, "0")}`;
}

export default async function VisitsIndexPage({ searchParams }: SearchProps) {
  await requireActiveStaff();
  const params = await searchParams;

  const start = isISODate(params.start) ? params.start : "";
  const end = isISODate(params.end) ? params.end : "";
  const kind = isVisitClass(params.kind) ? params.kind : null;
  const page = Math.max(1, Number(params.page) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const supabase = await createClient();

  // --- 1. The page of visits ------------------------------------------------
  // `test_requests!inner` is a predicate only: it keeps visits that still have
  // a live line of the chosen class. Embedding it doesn't multiply visit rows
  // (PostgREST nests to-many embeds rather than flattening them), so `count`
  // stays a visit count.
  let query = supabase
    .from("visits")
    .select(
      kind
        ? `${VISIT_SELECT}, test_requests!inner ( id, services!inner ( id ) )`
        : VISIT_SELECT,
      { count: "exact" },
    )
    .is("deleted_at", null)
    .order("visit_date", { ascending: false })
    .order("created_at", { ascending: false })
    // Total order — without a tie-break, `range()` can drop or repeat rows
    // across pages when two visits share a date and a timestamp.
    .order("id", { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);

  if (start) query = query.gte("visit_date", start);
  if (end) query = query.lte("visit_date", end);

  if (kind) {
    // A soft-deleted line must not keep its visit in the filtered view.
    query = query.is("test_requests.deleted_at", null);
    const { negated, kinds } = kindPredicateFor(kind);
    query = negated
      ? query.not("test_requests.services.kind", "in", `(${kinds.join(",")})`)
      : query.in("test_requests.services.kind", [...kinds]);
  }

  const { data: pageVisits, count } = await query.returns<VisitRow[]>();
  const pageRows = pageVisits ?? [];
  const pageIds = new Set(pageRows.map((v) => v.id));

  // --- 2. Top up the other halves of any split visit on this page -----------
  // A split encounter is two visits sharing a visit_group_id (0090). Both
  // halves are needed to render the row even when the page window or the kind
  // chip only reached one of them.
  const groupIds = Array.from(
    new Set(
      pageRows
        .map((v) => v.visit_group_id)
        .filter((g): g is string => g !== null),
    ),
  );

  let siblingRows: VisitRow[] = [];
  if (groupIds.length > 0) {
    let siblings = supabase
      .from("visits")
      .select(VISIT_SELECT)
      .in("visit_group_id", groupIds)
      .is("deleted_at", null);
    if (start) siblings = siblings.gte("visit_date", start);
    if (end) siblings = siblings.lte("visit_date", end);
    const { data } = await siblings.returns<VisitRow[]>();
    siblingRows = (data ?? []).filter((v) => !pageIds.has(v.id));
  }

  // --- 3. Live lines for everything on screen -------------------------------
  const allVisits = [...pageRows, ...siblingRows];
  const kindsByVisit = new Map<string, string[]>();
  const lineCount = new Map<string, number>();

  if (allVisits.length > 0) {
    const { data: lines } = await supabase
      .from("test_requests")
      .select("visit_id, services ( kind )")
      .in(
        "visit_id",
        allVisits.map((v) => v.id),
      )
      .is("deleted_at", null)
      .returns<LineRow[]>();

    for (const line of lines ?? []) {
      lineCount.set(line.visit_id, (lineCount.get(line.visit_id) ?? 0) + 1);
      const bucket = kindsByVisit.get(line.visit_id);
      if (bucket) bucket.push(kindOf(line));
      else kindsByVisit.set(line.visit_id, [kindOf(line)]);
    }
  }

  /** Does this visit satisfy the active kind chip? Mirrors the SQL predicate. */
  function passesKind(visit: VisitRow): boolean {
    if (!kind) return true;
    return (kindsByVisit.get(visit.id) ?? []).some(
      (k) => classifyKind(k) === kind,
    );
  }

  // --- 4. Fold into encounter rows ------------------------------------------
  const folded = foldVisitGroups(allVisits, passesKind)
    // Render a group exactly once: on the page its anchor landed on. A group
    // whose halves straddle a page boundary would otherwise appear on both.
    .filter((f) => pageIds.has(f.anchorId));

  const rows = folded.map((f) => {
    const kinds = f.members.flatMap((m) => kindsByVisit.get(m.id) ?? []);
    return {
      key: f.key,
      split: f.split,
      members: f.members,
      patient: f.members[0]!.patients,
      visitDate: f.members[0]!.visit_date,
      classes: classesForKinds(kinds),
      testCount: f.members.reduce(
        (sum, m) => sum + (lineCount.get(m.id) ?? 0),
        0,
      ),
      total: f.members.reduce((sum, m) => sum + Number(m.total_php), 0),
      paid: f.members.reduce((sum, m) => sum + Number(m.paid_php), 0),
      status: combinePaymentStatus(f.members.map((m) => m.payment_status)),
      methods: methodsFor(f.members.flatMap((m) => m.payments ?? [])),
    };
  });

  // Paging counts VISITS, not folded encounters — a distinct count over
  // coalesce(visit_group_id, id) isn't expressible through PostgREST. Split
  // encounters only exist when one counter order mixes doctor and lab lines,
  // so this is at most a row or two of drift per page; the header says
  // "visits", which stays true either way.
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const splitCount = rows.filter((r) => r.split).length;

  function buildHref(overrides: Record<string, string | null>): string {
    const sp = new URLSearchParams();
    const base: Record<string, string> = {
      start,
      end,
      kind: kind ?? "",
      page: safePage > 1 ? String(safePage) : "",
    };
    for (const [k, v] of Object.entries({ ...base, ...overrides })) {
      if (v) sp.set(k, v);
    }
    const qs = sp.toString();
    return `/staff/visits${qs ? `?${qs}` : ""}`;
  }

  const rangeLabel =
    start && end
      ? `${start} → ${end}`
      : start
        ? `from ${start}`
        : end
          ? `up to ${end}`
          : "all dates";

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Visits"
        subtitle={
          <>
            {total} visit{total === 1 ? "" : "s"} · {rangeLabel}
            {kind ? ` · ${VISIT_CLASS_LABEL[kind]} only` : null}
            {splitCount > 0
              ? ` · ${splitCount} split visit${splitCount === 1 ? "" : "s"} shown as one row`
              : null}
          </>
        }
        actions={
          <nav
            aria-label="Filter by classification"
            className="flex flex-wrap gap-2 text-sm"
          >
            <FilterTab
              href={buildHref({ kind: null, page: null })}
              label="All"
              active={kind === null}
            />
            {VISIT_CLASSES.map((c) => (
              <FilterTab
                key={c}
                href={buildHref({ kind: c, page: null })}
                label={VISIT_CLASS_LABEL[c]}
                active={kind === c}
              />
            ))}
          </nav>
        }
      />

      <div className="mb-6"><VisitsTabs /></div>

      <form
        className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4"
        action="/staff/visits"
      >
        {/* Keep the open classification chip when dates are applied. */}
        {kind ? <input type="hidden" name="kind" value={kind} /> : null}
        <div className="flex flex-col">
          <label
            htmlFor="start"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Start date
          </label>
          <input
            type="date"
            id="start"
            name="start"
            defaultValue={start}
            max={todayManilaISODate()}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col">
          <label
            htmlFor="end"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            End date
          </label>
          <input
            type="date"
            id="end"
            name="end"
            defaultValue={end}
            max={todayManilaISODate()}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <button
          type="submit"
          className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[color:var(--color-brand-cyan-mid)]"
        >
          Apply
        </button>
        {start || end || kind ? (
          <Link
            href="/staff/visits"
            className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm text-[color:var(--color-brand-text-soft)] transition-colors hover:border-[color:var(--color-brand-cyan)]"
          >
            Clear filters
          </Link>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <Panel className="p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
          {kind
            ? `No ${VISIT_CLASS_LABEL[kind].toLowerCase()} visits in this range.`
            : "No visits in this range."}
        </Panel>
      ) : (
        <>
          {/* Desktop table */}
          <Panel className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">
                    Date
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">
                    Visit #
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">
                    Patient
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">
                    Classification
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider">
                    Tests
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider">
                    Total
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider">
                    Paid
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">
                    Method
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.key}
                    className="border-t border-[color:var(--color-brand-bg-mid)]"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-[color:var(--color-brand-text-soft)]">
                      {r.visitDate}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                        {r.members.map((m, i) => (
                          <span key={m.id} className="whitespace-nowrap">
                            {i > 0 ? (
                              <span
                                aria-hidden="true"
                                className="mr-1.5 text-[color:var(--color-brand-text-soft)]"
                              >
                                +
                              </span>
                            ) : null}
                            <Link
                              href={`/staff/visits/${m.id}`}
                              className="text-[color:var(--color-brand-cyan)] hover:underline"
                            >
                              {visitNo(m.visit_number)}
                            </Link>
                          </span>
                        ))}
                      </span>
                      {r.split ? (
                        <span className="mt-1 block font-sans text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                          Split visit
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/staff/patients/${r.patient.id}`}
                        className="text-[color:var(--color-brand-navy)] hover:underline"
                      >
                        {formatPatientName(r.patient)}
                      </Link>{" "}
                      <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                        ({r.patient.drm_id})
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <ClassificationBadges classes={r.classes} />
                    </td>
                    <td className="px-4 py-3 text-right">{r.testCount}</td>
                    <td className="px-4 py-3 text-right font-mono">
                      {PHP.format(r.total)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {PHP.format(r.paid)}
                    </td>
                    <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                      {r.methods}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[r.status] ?? ""}`}
                      >
                        {paymentStatusLabel(r.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          {/* Mobile card list */}
          <div className="space-y-3 md:hidden">
            {rows.map((r) => (
              <article
                key={r.key}
                className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-x-1.5">
                    {r.members.map((m, i) => (
                      <span key={m.id} className="font-mono text-xs">
                        {i > 0 ? (
                          <span
                            aria-hidden="true"
                            className="mr-1.5 text-[color:var(--color-brand-text-soft)]"
                          >
                            +
                          </span>
                        ) : null}
                        <Link
                          href={`/staff/visits/${m.id}`}
                          className="text-[color:var(--color-brand-cyan)] hover:underline"
                        >
                          {visitNo(m.visit_number)}
                        </Link>
                      </span>
                    ))}
                    {r.split ? (
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                        Split visit
                      </span>
                    ) : null}
                  </span>
                  <span
                    className={`inline-block shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[r.status] ?? ""}`}
                  >
                    {paymentStatusLabel(r.status)}
                  </span>
                </div>
                <Link
                  href={`/staff/patients/${r.patient.id}`}
                  className="mt-1 block font-medium text-[color:var(--color-brand-navy)] hover:underline"
                >
                  {formatPatientName(r.patient)}
                </Link>
                <div className="text-xs text-[color:var(--color-brand-text-soft)]">
                  {r.patient.drm_id} · {r.visitDate} · {r.testCount} test
                  {r.testCount === 1 ? "" : "s"}
                </div>
                <div className="mt-2">
                  <ClassificationBadges classes={r.classes} />
                </div>
                <div className="mt-2 flex justify-between text-xs">
                  <span>
                    Total:{" "}
                    <span className="font-mono">{PHP.format(r.total)}</span>
                  </span>
                  <span>
                    Paid: <span className="font-mono">{PHP.format(r.paid)}</span>
                  </span>
                </div>
                <div className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
                  {r.methods}
                </div>
              </article>
            ))}
          </div>

          {totalPages > 1 ? (
            <nav className="mt-6 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-[color:var(--color-brand-text-soft)]">
                Page {safePage} of {totalPages}
              </p>
              <div className="flex gap-2">
                {safePage > 1 ? (
                  <Link
                    href={buildHref({ page: String(safePage - 1) })}
                    className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm transition-colors hover:border-[color:var(--color-brand-cyan)]"
                  >
                    ← Previous
                  </Link>
                ) : (
                  <span className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm text-[color:var(--color-brand-text-soft)] opacity-50">
                    ← Previous
                  </span>
                )}
                {safePage < totalPages ? (
                  <Link
                    href={buildHref({ page: String(safePage + 1) })}
                    className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm transition-colors hover:border-[color:var(--color-brand-cyan)]"
                  >
                    Next →
                  </Link>
                ) : (
                  <span className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm text-[color:var(--color-brand-text-soft)] opacity-50">
                    Next →
                  </span>
                )}
              </div>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}

function ClassificationBadges({ classes }: { classes: VisitClass[] }) {
  if (classes.length === 0) {
    return (
      <span className="text-xs text-[color:var(--color-brand-text-soft)]">—</span>
    );
  }
  return (
    <span className="flex flex-wrap gap-1">
      {classes.map((c) => (
        <span
          key={c}
          className={`inline-block whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-semibold ${CLASS_BADGE[c]}`}
        >
          {VISIT_CLASS_LABEL[c]}
        </span>
      ))}
    </span>
  );
}

function FilterTab({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={sectionTabClass(active)}
      aria-current={active ? "page" : undefined}
    >
      {label}
    </Link>
  );
}
