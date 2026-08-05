import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { CONTACT, SITE } from "@/lib/marketing/site";
import { formatPatientName } from "@/lib/patients/format-name";
import { pesosInWords } from "@/lib/accounting/amount-in-words";
import { formatPfMethod, pfBasisShortLabel } from "@/lib/accounting/pf-labels";
import { SlipPrintButton } from "./slip-print-button";

export const metadata = { title: "PF payout slip — staff" };
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Types — PostgREST embeds arrive as an object or a one-element array
// depending on how it infers the relationship, so every embed is plucked.
// ---------------------------------------------------------------------------

type Embed<T> = T | T[] | null;

// Money on a signed document always shows centavos — unlike `formatPhp`,
// which drops them. Matches the payout detail page it prints from.
const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

interface PhysicianRef {
  id: string;
  full_name: string;
  specialty: string | null;
}

interface StaffRef {
  id: string;
  full_name: string;
}

interface DisbursementRow {
  id: string;
  batch_number: number;
  posted_date: string;
  method: string;
  total_php: number;
  notes: string | null;
  voided_at: string | null;
  void_reason: string | null;
  recorded_at: string;
  physician_id: string;
  physicians: Embed<PhysicianRef>;
  recorded_by_staff: Embed<StaffRef>;
}

interface PatientRef {
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  drm_id: string;
}

interface EntryRow {
  id: string;
  pf_php: number;
  recognition_basis: string;
  recognized_at: string | null;
  test_request_id: string;
  test_requests: Embed<{
    id: string;
    services: Embed<{ code: string; name: string }>;
    visits: Embed<{
      visit_number: string;
      visit_date: string;
      patients: Embed<PatientRef>;
    }>;
  }>;
}

/** One flattened printable line. */
interface SlipLine {
  id: string;
  date: string;
  patient: string;
  drmId: string;
  visitNumber: string;
  service: string;
  basis: string;
  amount: number;
}

function pluck<T>(v: Embed<T>): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function manilaDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function manilaDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-PH", { timeZone: "Asia/Manila" });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function PfPayoutSlipPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminStaff();
  const { id } = await params;
  const admin = createAdminClient();

  const { data: disb } = await admin
    .from("doctor_pf_disbursements")
    .select(
      `
      id, batch_number, posted_date, method, total_php, notes,
      voided_at, void_reason, recorded_at, physician_id,
      physicians ( id, full_name, specialty ),
      recorded_by_staff:staff_profiles!recorded_by ( id, full_name )
    `,
    )
    .eq("id", id)
    .maybeSingle<DisbursementRow>();

  if (!disb) notFound();

  const year = disb.posted_date.slice(0, 4);

  const [{ data: entries }, { data: ytdDisbursements }] = await Promise.all([
    admin
      .from("doctor_pf_entries")
      .select(
        `
        id, pf_php, recognition_basis, recognized_at, test_request_id,
        test_requests (
          id,
          services ( code, name ),
          visits ( visit_number, visit_date, patients ( first_name, middle_name, last_name, drm_id ) )
        )
      `,
      )
      .eq("disbursement_id", id)
      .order("recognized_at", { ascending: true })
      .returns<EntryRow[]>(),
    // Year-to-date footer. Matches the "Paid out" column on the doctor-pay
    // report: non-voided disbursements posted in the same calendar year.
    admin
      .from("doctor_pf_disbursements")
      .select("id, total_php")
      .eq("physician_id", disb.physician_id)
      .gte("posted_date", `${year}-01-01`)
      .lte("posted_date", `${year}-12-31`)
      .is("voided_at", null)
      .returns<{ id: string; total_php: number }[]>(),
  ]);

  const lines: SlipLine[] = (entries ?? []).map((e) => {
    const tr = pluck(e.test_requests);
    const svc = pluck(tr?.services ?? null);
    const visit = pluck(tr?.visits ?? null);
    const patient = pluck(visit?.patients ?? null);
    return {
      id: e.id,
      date: e.recognized_at ? manilaDate(e.recognized_at) : "—",
      patient: patient ? formatPatientName(patient) || "(no name on file)" : "—",
      drmId: patient?.drm_id ?? "",
      visitNumber: visit?.visit_number ?? "",
      service: svc?.name ?? "—",
      basis: pfBasisShortLabel(e.recognition_basis),
      amount: Number(e.pf_php ?? 0),
    };
  });

  const linesTotal = lines.reduce((s, l) => s + l.amount, 0);
  const total = Number(disb.total_php ?? 0);
  const physician = pluck(disb.physicians);
  const recordedBy = pluck(disb.recorded_by_staff);
  const isVoided = Boolean(disb.voided_at);

  const ytdTotal = (ytdDisbursements ?? []).reduce(
    (s, d) => s + Number(d.total_php ?? 0),
    0,
  );
  const ytdCount = (ytdDisbursements ?? []).length;

  const slip = {
    batchLabel: `PF-${year}-${String(disb.batch_number).padStart(4, "0")}`,
    postedDate: manilaDate(disb.posted_date),
    method: formatPfMethod(disb.method),
    notes: disb.notes,
    doctorName: physician?.full_name ?? "(unknown doctor)",
    doctorSpecialty: physician?.specialty ?? null,
    releasedBy: recordedBy?.full_name ?? "(unknown)",
    recordedAt: manilaDateTime(disb.recorded_at),
    total,
    totalInWords: pesosInWords(total),
    lines,
    // A mismatch means an entry was unlinked after the header was written.
    // Print it rather than hide it — the doctor is signing for the header
    // total, and the clinic needs to see the discrepancy before it does.
    //
    // Voiding is the one case where an empty table is expected, not an
    // anomaly: voidPfDisbursement unlinks every entry, so a voided batch
    // ALWAYS lists nothing. Warning "check the batch before signing" there
    // would fire on every voided print and contradict the "do not sign"
    // banner right below it.
    linesTotal,
    hasMismatch: !isVoided && Math.abs(linesTotal - total) > 0.005,
    isVoided,
    voidedAt: disb.voided_at ? manilaDateTime(disb.voided_at) : null,
    voidReason: disb.void_reason,
    year,
    ytdTotal,
    ytdCount,
  };

  return (
    <div className="payout-slip-print mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8 print:max-w-none print:p-0">
      <div className="mb-4 flex items-center justify-between gap-2 print:hidden">
        <Link
          href={`/staff/admin/accounting/pf-payouts/${disb.id}`}
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Payout {slip.batchLabel}
        </Link>
        <SlipPrintButton disbursementId={disb.id} batchLabel={slip.batchLabel} />
      </div>

      {isVoided ? (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 print:hidden">
          This payout was voided on {slip.voidedAt}. The slip prints for the
          file, marked VOIDED, with no signature block — a reversed payout must
          not be signed for.
        </p>
      ) : null}

      <SlipCopy copyLabel="Doctor's copy" slip={slip} />
      <SlipCopy copyLabel="Clinic file copy" slip={slip} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// One printed copy
// ---------------------------------------------------------------------------

type Slip = {
  batchLabel: string;
  postedDate: string;
  method: string;
  notes: string | null;
  doctorName: string;
  doctorSpecialty: string | null;
  releasedBy: string;
  recordedAt: string;
  total: number;
  totalInWords: string;
  lines: SlipLine[];
  linesTotal: number;
  hasMismatch: boolean;
  isVoided: boolean;
  voidedAt: string | null;
  voidReason: string | null;
  year: string;
  ytdTotal: number;
  ytdCount: number;
};

function SlipCopy({ copyLabel, slip }: { copyLabel: string; slip: Slip }) {
  return (
    <article className="payout-slip-copy payout-slip-sheet mb-8 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-8 last:mb-0 print:mb-0 print:border-0 print:p-0 print:text-xs">
      <header className="flex items-start justify-between gap-4 border-b border-[color:var(--color-brand-bg-mid)] pb-4 print:pb-2">
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element -- plain img prints reliably */}
          <img
            src="/logo.png"
            alt="DRMed"
            className="mb-2 h-14 w-auto print:mb-1 print:h-10"
          />
          <p className="font-heading text-2xl font-extrabold text-[color:var(--color-brand-navy)] print:text-lg">
            {SITE.name}
          </p>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            {CONTACT.address.line1}, {CONTACT.address.line2},{" "}
            {CONTACT.address.city}
          </p>
          <p className="text-xs text-[color:var(--color-brand-text-soft)]">
            {CONTACT.phone.mobile} · {CONTACT.phone.landline} · {CONTACT.email}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            {copyLabel}
          </p>
          <p className="mt-1 font-mono text-lg font-extrabold text-[color:var(--color-brand-navy)] print:text-base">
            {slip.batchLabel}
          </p>
          {slip.isVoided ? (
            <p className="mt-1 inline-block rounded border-2 border-red-600 px-2 py-0.5 text-xs font-extrabold uppercase tracking-widest text-red-700">
              Voided
            </p>
          ) : null}
        </div>
      </header>

      <p className="mt-4 text-center font-heading text-lg font-extrabold uppercase tracking-wide text-[color:var(--color-brand-navy)] print:mt-2 print:text-sm">
        Professional fee payout acknowledgment
      </p>

      <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 print:mt-2 print:gap-y-1 print:text-xs">
        <div className="flex gap-2">
          <dt className="text-[color:var(--color-brand-text-soft)]">Doctor</dt>
          <dd className="font-semibold text-[color:var(--color-brand-navy)]">
            {slip.doctorName}
            {slip.doctorSpecialty ? (
              <span className="ml-1 font-normal text-[color:var(--color-brand-text-soft)]">
                · {slip.doctorSpecialty}
              </span>
            ) : null}
          </dd>
        </div>
        <div className="flex gap-2 sm:justify-end">
          <dt className="text-[color:var(--color-brand-text-soft)]">
            Payout date
          </dt>
          <dd className="font-semibold">{slip.postedDate}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-[color:var(--color-brand-text-soft)]">Paid by</dt>
          <dd className="font-semibold">{slip.method}</dd>
        </div>
        <div className="flex gap-2 sm:justify-end">
          <dt className="text-[color:var(--color-brand-text-soft)]">
            Released by
          </dt>
          <dd className="font-semibold">{slip.releasedBy}</dd>
        </div>
      </dl>

      <table className="mt-4 w-full text-sm print:mt-2 print:text-[10px]">
        <thead className="text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)] print:text-[9px]">
          <tr className="border-b border-[color:var(--color-brand-bg-mid)]">
            <th className="py-2 print:py-1">Date</th>
            <th className="py-2 print:py-1">Patient / visit</th>
            <th className="py-2 print:py-1">Service</th>
            <th className="py-2 print:py-1">Paid by</th>
            <th className="py-2 text-right print:py-1">Fee</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
          {slip.lines.length === 0 ? (
            <tr>
              <td
                colSpan={5}
                className="py-4 text-center text-[color:var(--color-brand-text-soft)]"
              >
                {slip.isVoided
                  ? "The fee entries returned to the open list when this payout was voided."
                  : "No fee entries are linked to this payout."}
              </td>
            </tr>
          ) : (
            slip.lines.map((l) => (
              <tr key={l.id} className="print:break-inside-avoid">
                <td className="py-2 whitespace-nowrap print:py-1">{l.date}</td>
                <td className="py-2 print:py-1">
                  {l.patient}
                  {l.visitNumber ? (
                    <span className="text-[color:var(--color-brand-text-soft)]">
                      {" "}
                      · #{l.visitNumber}
                    </span>
                  ) : null}
                  {l.drmId ? (
                    <span className="block font-mono text-xs text-[color:var(--color-brand-text-soft)] print:text-[9px]">
                      {l.drmId}
                    </span>
                  ) : null}
                </td>
                <td className="py-2 print:py-1">{l.service}</td>
                <td className="py-2 text-[color:var(--color-brand-text-soft)] print:py-1">
                  {l.basis}
                </td>
                <td className="py-2 text-right font-mono print:py-1">
                  {PHP.format(l.amount)}
                </td>
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-[color:var(--color-brand-navy)]">
            <td colSpan={4} className="py-3 text-right font-bold print:py-1.5">
              Total ({slip.lines.length}{" "}
              {slip.lines.length === 1 ? "entry" : "entries"})
            </td>
            <td className="py-3 text-right font-heading text-xl font-extrabold print:py-1.5 print:text-base">
              {PHP.format(slip.total)}
            </td>
          </tr>
        </tfoot>
      </table>

      {slip.hasMismatch ? (
        <p className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 print:break-inside-avoid">
          The listed entries add up to {PHP.format(slip.linesTotal)}, which does
          not match the recorded payout total. Check the batch before signing.
        </p>
      ) : null}

      <p className="mt-3 text-sm print:mt-2 print:text-xs">
        <span className="text-[color:var(--color-brand-text-soft)]">
          Amount in words:{" "}
        </span>
        <span className="font-semibold text-[color:var(--color-brand-navy)]">
          {slip.totalInWords}
        </span>
      </p>

      {slip.notes ? (
        <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
          Notes: {slip.notes}
        </p>
      ) : null}

      {slip.isVoided ? (
        <div className="mt-5 rounded-xl border-2 border-red-300 bg-red-50 p-4 text-sm text-red-900 print:mt-3 print:break-inside-avoid print:p-2 print:text-xs">
          <p className="font-bold uppercase tracking-wider">
            Voided — not valid for payment
          </p>
          <p className="mt-1">
            This payout was reversed on {slip.voidedAt}. Reason:{" "}
            {slip.voidReason ?? "(none recorded)"}. The fee entries above have
            returned to the open list. Do not sign this copy.
          </p>
        </div>
      ) : (
        <>
          <p className="mt-5 text-sm leading-relaxed print:mt-3 print:text-xs">
            I acknowledge having received from <strong>{SITE.name}</strong> the
            sum of <strong>{PHP.format(slip.total)}</strong> (
            {slip.totalInWords}), paid via {slip.method}, in full settlement of
            my professional fees for the consultations and procedures listed
            above.
          </p>

          <div className="mt-8 grid gap-8 sm:grid-cols-2 print:mt-6 print:gap-6 print:break-inside-avoid">
            <div>
              <div className="border-b border-[color:var(--color-brand-navy)]" />
              <p className="mt-1 text-sm font-semibold text-[color:var(--color-brand-navy)] print:text-xs">
                {slip.doctorName}
              </p>
              <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                Received by (signature over printed name)
              </p>
              <p className="mt-3 text-xs text-[color:var(--color-brand-text-soft)] print:mt-2">
                Date received: ______________________
              </p>
            </div>
            <div>
              <div className="border-b border-[color:var(--color-brand-navy)]" />
              <p className="mt-1 text-sm font-semibold text-[color:var(--color-brand-navy)] print:text-xs">
                {slip.releasedBy}
              </p>
              <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                Released by (signature over printed name)
              </p>
              <p className="mt-3 text-xs text-[color:var(--color-brand-text-soft)] print:mt-2">
                Date released: {slip.postedDate}
              </p>
            </div>
          </div>
        </>
      )}

      <footer className="mt-6 border-t border-[color:var(--color-brand-bg-mid)] pt-3 text-xs text-[color:var(--color-brand-text-soft)] print:mt-3 print:pt-2 print:text-[9px]">
        <p>
          Paid to {slip.doctorName} in {slip.year}:{" "}
          <strong className="text-[color:var(--color-brand-navy)]">
            {PHP.format(slip.ytdTotal)}
          </strong>{" "}
          across {slip.ytdCount}{" "}
          {slip.ytdCount === 1 ? "payout" : "payouts"}.{" "}
          {slip.isVoided
            ? "This payout was voided, so it is not counted; nor is any other voided payout."
            : "This payout is included; voided ones are excluded."}
        </p>
        <p className="mt-1">
          Batch {slip.batchLabel} · recorded {slip.recordedAt} · {copyLabel}.
          This slip is a payout acknowledgment, not an official receipt for tax
          purposes.
        </p>
      </footer>
    </article>
  );
}
