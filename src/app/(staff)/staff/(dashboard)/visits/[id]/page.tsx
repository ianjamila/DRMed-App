import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { formatPhp } from "@/lib/marketing/format";
import { sectionsForRole } from "@/lib/auth/role-sections";
import { ReleaseButton } from "./release-button";
import { VoidPaymentDialog } from "../../payments/[id]/void/void-payment-dialog";
import { isConsentGateRequired, getPatientConsentState } from "@/lib/consent/gate";

export const metadata = {
  title: "Visit — staff",
};

interface Props {
  params: Promise<{ id: string }>;
}

const PAYMENT_STATUS_STYLE: Record<string, string> = {
  unpaid: "bg-red-100 text-red-900",
  partial: "bg-amber-100 text-amber-900",
  paid: "bg-emerald-100 text-emerald-900",
  waived: "bg-slate-200 text-slate-800",
};

const TEST_STATUS_STYLE: Record<string, string> = {
  requested: "bg-slate-200 text-slate-800",
  in_progress: "bg-sky-100 text-sky-900",
  result_uploaded: "bg-amber-100 text-amber-900",
  ready_for_release: "bg-emerald-100 text-emerald-900",
  released: "bg-[color:var(--color-brand-navy)] text-white",
  cancelled: "bg-red-100 text-red-900",
};

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  gcash: "GCash",
  maya: "Maya",
  card: "Card",
  bank_transfer: "Bank transfer",
  hmo: "HMO",
  bpi: "BPI",
  maybank: "Maybank",
};

const DISCOUNT_KIND_LABEL: Record<string, string> = {
  senior_pwd_20: "Sr/PWD",
  pct_10: "10% off",
  pct_5: "5% off",
  other_pct_20: "Other 20%",
  custom: "Custom",
};

export default async function VisitDetailPage({ params }: Props) {
  const { id } = await params;
  const session = await requireActiveStaff();
  const isAdmin = session.role === "admin";
  const supabase = await createClient();

  const { data: visit } = await supabase
    .from("visits")
    .select(
      `
        id, visit_number, visit_date, payment_status,
        total_php, paid_php, notes, created_at,
        visit_group_id,
        hmo_provider_id, hmo_approval_date, hmo_authorization_no,
        patients!inner ( id, drm_id, first_name, last_name, preferred_release_medium ),
        hmo_providers ( id, name )
      `,
    )
    .eq("id", id)
    .maybeSingle();

  if (!visit) notFound();

  let sibling: { id: string; visit_number: string; is_doctor: boolean } | null = null;
  if (visit.visit_group_id) {
    const { data: sibs } = await supabase
      .from("visits")
      .select("id, visit_number, test_requests ( services ( kind ) )")
      .eq("visit_group_id", visit.visit_group_id)
      .neq("id", visit.id);
    const s = sibs?.[0];
    if (s) {
      const isDoctor = (s.test_requests ?? []).some((tr) => {
        const svc = Array.isArray(tr.services) ? tr.services[0] : tr.services;
        return svc != null && (svc.kind === "doctor_consultation" || svc.kind === "doctor_procedure");
      });
      sibling = { id: s.id, visit_number: s.visit_number, is_doctor: isDoctor };
    }
  }

  const patient = Array.isArray(visit.patients) ? visit.patients[0] : visit.patients;
  if (!patient) notFound();
  const hmo = Array.isArray(visit.hmo_providers)
    ? visit.hmo_providers[0]
    : visit.hmo_providers;

  // Consent release-gate state for this patient. When the gate is on and
  // consent is missing, the Release button is hard-disabled (the DB trigger
  // would reject the release anyway). When off, missing consent only shows a
  // soft amber warning.
  const [gateRequired, consent] = await Promise.all([
    isConsentGateRequired(),
    getPatientConsentState(patient.id),
  ]);

  const [{ data: tests }, { data: payments }] = await Promise.all([
    supabase
      .from("test_requests")
      .select(
        `
          id, status, requested_at, completed_at, released_at, release_medium,
          base_price_php, discount_kind, discount_amount_php, final_price_php,
          clinic_fee_php, doctor_pf_php,
          procedure_description, hmo_approved_amount_php,
          parent_id, is_package_header, package_completed_at,
          services!inner ( id, code, name, kind, section, price_php )
        `,
      )
      .eq("visit_id", id)
      .order("is_package_header", { ascending: false })
      .order("requested_at", { ascending: true }),
    supabase
      .from("payments")
      .select("id, amount_php, method, reference_number, received_at, notes, voided_at, voided_by, void_reason")
      .eq("visit_id", id)
      .order("received_at", { ascending: false }),
  ]);

  // Which test_requests have a released PDF in storage. Single query keyed
  // by test_request_id so the TestAction component can render a "View PDF"
  // link without each row firing its own join.
  const allTestIds = (tests ?? []).map((t) => t.id);
  const hasPdfByTrId = new Map<string, boolean>();
  if (allTestIds.length > 0) {
    const { data: pdfLinks } = await supabase
      .from("result_test_requests")
      .select("test_request_id, results!inner ( storage_path )")
      .in("test_request_id", allTestIds);
    for (const link of pdfLinks ?? []) {
      const r = (link as { results: { storage_path: string | null } | { storage_path: string | null }[] | null }).results;
      const resolved = Array.isArray(r) ? r[0] : r;
      if (resolved?.storage_path) {
        hasPdfByTrId.set(link.test_request_id as string, true);
      }
    }
  }

  // Admin-only: fetch PF entries to render status badges per test_request.
  const testIds = (tests ?? []).map((t) => t.id);
  type PfEntry = {
    id: string;
    test_request_id: string;
    recognition_basis: string;
    recognized_at: string | null;
    disbursement_id: string | null;
    voided_at: string | null;
    pf_php: number;
  };
  const pfEntryByTrId = new Map<string, PfEntry>();
  if (isAdmin && testIds.length > 0) {
    const adminClient = createAdminClient();
    const { data: pfEntries } = await adminClient
      .from("doctor_pf_entries")
      .select("id, test_request_id, recognition_basis, recognized_at, disbursement_id, voided_at, pf_php")
      .in("test_request_id", testIds);
    for (const pfe of pfEntries ?? []) {
      // Show the most-recent non-clawback entry per test_request for badge display.
      if (pfe.recognition_basis !== "clawback" && !pfEntryByTrId.has(pfe.test_request_id)) {
        pfEntryByTrId.set(pfe.test_request_id, pfe as PfEntry);
      }
    }
  }

  const isPaid = visit.payment_status === "paid" || visit.payment_status === "waived";
  const balance = Number(visit.total_php) - Number(visit.paid_php);
  const activePayments = (payments ?? []).filter((p) => !p.voided_at);
  const voidedPayments = (payments ?? []).filter((p) => p.voided_at);

  // Section gate: hide tests outside this role's sections (medtech sees
  // lab bench, xray sees imaging, reception sees none, admin + pathologist
  // see everything). Package headers are visible if ANY of their
  // components are accessible — we don't want a half-visible package.
  const allowedSections = sectionsForRole(session.role); // null = unrestricted
  const rawRows = tests ?? [];
  const isVisible = (r: { services: { section?: string | null } | { section?: string | null }[] | null }) => {
    if (allowedSections === null) return true;
    if (allowedSections.length === 0) return false;
    const svc = Array.isArray(r.services) ? r.services[0] : r.services;
    const sect = svc?.section ?? null;
    return sect != null && allowedSections.includes(sect as never);
  };
  // First pass: mark which parent_ids have at least one visible component.
  const visibleParents = new Set<string>();
  for (const r of rawRows) {
    if (r.parent_id && isVisible(r)) visibleParents.add(r.parent_id);
  }
  const allRows = rawRows.filter((r) => {
    if (r.is_package_header) return visibleParents.has(r.id);
    return isVisible(r);
  });

  // Group test_requests by package: headers first (as cards with their
  // components indented beneath), then standalones below in the existing
  // detail table. Bridge guard in 14.1 ensures ₱0 package components don't
  // appear in standalone billing rows.
  type TestRow = (typeof allRows)[number];
  const packageHeaders: TestRow[] = [];
  const componentsByParent = new Map<string, TestRow[]>();
  const standalones: TestRow[] = [];
  for (const t of allRows) {
    if (t.is_package_header) {
      packageHeaders.push(t);
      continue;
    }
    if (t.parent_id) {
      const arr = componentsByParent.get(t.parent_id) ?? [];
      arr.push(t);
      componentsByParent.set(t.parent_id, arr);
    } else {
      standalones.push(t);
    }
  }

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href={`/staff/patients/${patient.id}`}
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← {patient.last_name}, {patient.first_name} ({patient.drm_id})
      </Link>

      <header className="mt-3 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="font-mono text-sm text-[color:var(--color-brand-text-soft)]">
            Visit #{visit.visit_number} ·{" "}
            {new Date(visit.visit_date).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })}
          </p>
          {sibling ? (
            <p className="mt-2 rounded-lg border border-dashed border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] px-3 py-2 text-xs text-[color:var(--color-brand-navy)]">
              Part of the same patient visit as{" "}
              <Link
                href={`/staff/visits/${sibling.id}`}
                className="font-bold text-[color:var(--color-brand-cyan)] hover:underline"
              >
                #{sibling.visit_number} — {sibling.is_doctor ? "Doctor / PF" : "Lab & Services"} →
              </Link>
            </p>
          ) : null}
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {patient.last_name}, {patient.first_name}
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/staff/visits/${visit.id}/receipt`}
            className="rounded-md border border-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-navy)] hover:text-white"
          >
            Receipt
          </Link>
          <Link
            href={`/staff/payments/new?visit_id=${visit.id}`}
            className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            Record payment
          </Link>
        </div>
      </header>

      <section className="mt-6 grid gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 sm:grid-cols-4">
        <Field label="Total" value={formatPhp(visit.total_php)} />
        <Field label="Paid" value={formatPhp(visit.paid_php)} />
        <Field
          label="Balance"
          value={formatPhp(balance > 0 ? balance : 0)}
          highlight={balance > 0}
        />
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Status
          </p>
          <p className="mt-1">
            <span
              className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                PAYMENT_STATUS_STYLE[visit.payment_status] ?? ""
              }`}
            >
              {visit.payment_status}
            </span>
          </p>
        </div>
      </section>

      {hmo ? (
        <section className="mt-6 rounded-xl border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] p-5">
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            HMO authorisation
          </p>
          <div className="mt-2 grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                Provider
              </p>
              <p className="font-semibold text-[color:var(--color-brand-navy)]">
                {hmo.name}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                Approval date
              </p>
              <p className="text-[color:var(--color-brand-text-mid)]">
                {visit.hmo_approval_date ?? "—"}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                Authorization no.
              </p>
              <p className="font-mono text-[color:var(--color-brand-text-mid)]">
                {visit.hmo_authorization_no ?? "—"}
              </p>
            </div>
          </div>
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="mb-3 font-[family-name:var(--font-heading)] text-xl font-extrabold text-[color:var(--color-brand-navy)]">
          Tests
        </h2>

        {packageHeaders.length > 0 ? (
          <div className="mb-4 space-y-4">
            {packageHeaders.map((h) => {
              const svc = Array.isArray(h.services) ? h.services[0] : h.services;
              if (!svc) return null;
              const finalPrice =
                h.final_price_php != null
                  ? Number(h.final_price_php)
                  : Number(svc.price_php);
              const components = componentsByParent.get(h.id) ?? [];
              return (
                <div
                  key={h.id}
                  className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5"
                >
                  <Link
                    href={`/staff/queue/${h.id}`}
                    className="block hover:opacity-90"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-mono text-[10px] uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                          {svc.code} · Package
                        </p>
                        <p className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
                          {svc.name}
                        </p>
                        {h.package_completed_at ? (
                          <p className="mt-1 text-[11px] text-emerald-700">
                            Completed{" "}
                            {new Date(h.package_completed_at).toLocaleString(
                              "en-PH",
                            )}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <span className="font-mono text-sm font-semibold text-[color:var(--color-brand-navy)]">
                          {formatPhp(finalPrice)}
                        </span>
                        <span
                          className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                            TEST_STATUS_STYLE[h.status] ?? ""
                          }`}
                        >
                          {h.status.replace(/_/g, " ")}
                        </span>
                      </div>
                    </div>
                  </Link>
                  <ul className="mt-3 space-y-1 border-l-2 border-[color:var(--color-brand-bg-mid)] pl-4">
                    {components.length === 0 ? (
                      <li className="py-1 text-xs text-[color:var(--color-brand-text-soft)]">
                        No components linked yet.
                      </li>
                    ) : (
                      components.map((c) => {
                        const csvc = Array.isArray(c.services)
                          ? c.services[0]
                          : c.services;
                        if (!csvc) return null;
                        return (
                          <li
                            key={c.id}
                            className="flex flex-wrap items-center justify-between gap-2 py-1 text-sm"
                          >
                            <Link
                              href={`/staff/queue/${c.id}`}
                              className="font-medium text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)] hover:underline"
                            >
                              {csvc.name}
                            </Link>
                            <span className="flex items-center gap-2 text-[11px] text-[color:var(--color-brand-text-soft)]">
                              <span className="font-mono uppercase tracking-wider">
                                {csvc.section ?? "—"}
                              </span>
                              <span
                                className={`rounded-md px-2 py-0.5 font-semibold ${
                                  TEST_STATUS_STYLE[c.status] ?? ""
                                }`}
                              >
                                {c.status.replace(/_/g, " ")}
                              </span>
                              {c.status === "released" && hasPdfByTrId.get(c.id) ? (
                                <a
                                  href={`/staff/results/${c.id}/pdf`}
                                  target="_blank"
                                  rel="noopener"
                                  className="font-bold text-[color:var(--color-brand-cyan)] hover:underline"
                                >
                                  PDF →
                                </a>
                              ) : null}
                            </span>
                          </li>
                        );
                      })
                    )}
                  </ul>
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Service</th>
                <th className="px-4 py-3 text-right">Base</th>
                <th className="px-4 py-3 text-right">Discount</th>
                <th className="px-4 py-3 text-right">Final</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {standalones.map((t) => {
                const svc = Array.isArray(t.services) ? t.services[0] : t.services;
                if (!svc) return null;
                // Snapshot fields on the line; fall back to live service price
                // for legacy rows created before P7B.2.
                const base =
                  t.base_price_php != null
                    ? Number(t.base_price_php)
                    : Number(svc.price_php);
                const discount =
                  t.discount_amount_php != null
                    ? Number(t.discount_amount_php)
                    : 0;
                const finalPrice =
                  t.final_price_php != null
                    ? Number(t.final_price_php)
                    : base - discount;
                const discountLabel = t.discount_kind
                  ? DISCOUNT_KIND_LABEL[t.discount_kind] ?? t.discount_kind
                  : null;
                const isConsult = svc.kind === "doctor_consultation";
                const isProcedure = svc.kind === "doctor_procedure";
                return (
                  <tr
                    key={t.id}
                    className="hover:bg-[color:var(--color-brand-bg)]"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/staff/queue/${t.id}`}
                        className="text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)] hover:underline"
                      >
                        {svc.name}
                      </Link>
                      <p className="font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                        {svc.code}
                        {isConsult ? (
                          <span className="ml-1 rounded bg-[color:var(--color-brand-bg-mid)] px-1 py-0.5 uppercase tracking-wider text-[color:var(--color-brand-navy)]">
                            Doctor
                          </span>
                        ) : null}
                        {isProcedure ? (
                          <span className="ml-1 rounded bg-[color:var(--color-brand-bg-mid)] px-1 py-0.5 uppercase tracking-wider text-[color:var(--color-brand-navy)]">
                            Procedure
                          </span>
                        ) : null}
                      </p>
                      {isConsult && (t.clinic_fee_php != null || t.doctor_pf_php != null) ? (
                        <p className="mt-1 text-[10px] text-[color:var(--color-brand-text-soft)]">
                          Clinic fee {formatPhp(Number(t.clinic_fee_php ?? 0))} ·
                          PF {formatPhp(Number(t.doctor_pf_php ?? 0))}
                        </p>
                      ) : null}
                      {isAdmin && pfEntryByTrId.has(t.id) ? (
                        <PfStatusBadge entry={pfEntryByTrId.get(t.id)!} />
                      ) : null}
                      {isProcedure && t.procedure_description ? (
                        <p className="mt-1 text-[10px] text-[color:var(--color-brand-text-mid)]">
                          {t.procedure_description}
                        </p>
                      ) : null}
                      {isProcedure && t.hmo_approved_amount_php != null ? (
                        <p className="mt-0.5 text-[10px] text-[color:var(--color-brand-text-soft)]">
                          HMO approved: {formatPhp(Number(t.hmo_approved_amount_php))}
                        </p>
                      ) : null}
                      {t.release_medium && t.released_at ? (
                        <p className="mt-1 text-[10px] text-emerald-700">
                          Released via {t.release_medium}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {formatPhp(base)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {discount > 0 ? (
                        <>
                          <span className="text-red-600">
                            −{formatPhp(discount)}
                          </span>
                          {discountLabel ? (
                            <span className="ml-1 text-[10px] uppercase text-[color:var(--color-brand-text-soft)]">
                              {discountLabel}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-[color:var(--color-brand-text-soft)]">
                          —
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm font-semibold text-[color:var(--color-brand-navy)]">
                      {formatPhp(finalPrice)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                          TEST_STATUS_STYLE[t.status] ?? ""
                        }`}
                      >
                        {t.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <TestAction
                        status={t.status}
                        testRequestId={t.id}
                        visitId={visit.id}
                        paid={isPaid}
                        consentOnFile={consent.current}
                        gateRequired={gateRequired}
                        hasPdf={hasPdfByTrId.get(t.id) === true}
                        preferredMedium={
                          (patient.preferred_release_medium ?? null) as
                            | "physical"
                            | "email"
                            | "viber"
                            | "gcash"
                            | "pickup"
                            | null
                        }
                      />
                    </td>
                  </tr>
                );
              })}
              {standalones.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                  >
                    {packageHeaders.length > 0
                      ? "No standalone tests on this visit."
                      : "No tests on this visit yet."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {!isPaid ? (
          <p className="mt-3 text-xs text-[color:var(--color-brand-text-soft)]">
            ℹ️ Releases are blocked until visit payment status is paid or
            waived. The payment-gating trigger enforces this at the database
            level.
          </p>
        ) : null}
      </section>

      <section className="mt-8">
        <h2 className="mb-3 font-[family-name:var(--font-heading)] text-xl font-extrabold text-[color:var(--color-brand-navy)]">
          Payments
        </h2>
        <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Method</th>
                <th className="px-4 py-3">Reference</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {activePayments.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {new Date(p.received_at).toLocaleString("en-PH", { timeZone: "Asia/Manila" })}
                  </td>
                  <td className="px-4 py-3 font-semibold">
                    {formatPhp(p.amount_php)}
                  </td>
                  <td className="px-4 py-3">
                    {p.method ? PAYMENT_METHOD_LABEL[p.method] ?? p.method : "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {p.reference_number ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <VoidPaymentDialog
                      paymentId={p.id}
                      amountLabel={formatPhp(p.amount_php)}
                    />
                  </td>
                </tr>
              ))}
              {activePayments.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-6 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                  >
                    No active payments.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {voidedPayments.length > 0 ? (
          <details className="mt-4 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] px-4 py-3">
            <summary className="cursor-pointer text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Voided payments ({voidedPayments.length})
            </summary>
            <ul className="mt-2 space-y-2 text-xs">
              {voidedPayments.map((p) => (
                <li key={p.id} className="rounded-md bg-white px-3 py-2">
                  <div className="font-semibold text-[color:var(--color-brand-text-mid)]">
                    {formatPhp(p.amount_php)} · {p.method ? PAYMENT_METHOD_LABEL[p.method] ?? p.method : "—"}
                    <span className="ml-2 text-[color:var(--color-brand-text-soft)]">
                      voided {p.voided_at ? new Date(p.voided_at).toLocaleString("en-PH", { timeZone: "Asia/Manila" }) : ""}
                    </span>
                  </div>
                  {p.void_reason ? (
                    <div className="mt-1 text-[color:var(--color-brand-text-soft)]">
                      Reason: {p.void_reason}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      {visit.notes ? (
        <section className="mt-8 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 text-sm">
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Visit notes
          </p>
          <p className="mt-2 whitespace-pre-wrap text-[color:var(--color-brand-text-mid)]">
            {visit.notes}
          </p>
        </section>
      ) : null}

      <Link
        href={`/staff/patients/${patient.id}`}
        className="mt-8 inline-block rounded-md border border-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-navy)] hover:text-white"
      >
        Back to patient
      </Link>
    </div>
  );
}

function Field({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p
        className={`mt-1 font-[family-name:var(--font-heading)] text-2xl font-extrabold ${
          highlight ? "text-red-600" : "text-[color:var(--color-brand-navy)]"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

interface PfEntryShape {
  recognition_basis: string;
  recognized_at: string | null;
  disbursement_id: string | null;
  voided_at: string | null;
}

function PfStatusBadge({ entry }: { entry: PfEntryShape }) {
  if (entry.voided_at) {
    return (
      <span className="mt-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
        PF voided
      </span>
    );
  }
  if (entry.recognition_basis === "hmo_at_settlement" && !entry.recognized_at) {
    return (
      <span className="mt-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
        PF pending HMO settlement
      </span>
    );
  }
  if (entry.disbursement_id) {
    return (
      <span className="mt-1 inline-block rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800">
        PF paid
      </span>
    );
  }
  if (entry.recognized_at) {
    return (
      <span className="mt-1 inline-block rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
        PF accrued
      </span>
    );
  }
  return null;
}

interface TestActionProps {
  status: string;
  testRequestId: string;
  visitId: string;
  paid: boolean;
  preferredMedium: "physical" | "email" | "viber" | "gcash" | "pickup" | null;
  consentOnFile: boolean;
  gateRequired: boolean;
  hasPdf?: boolean;
}

// Renders a context-appropriate cell for the Action column on the visit
// detail tests table. Tells the receptionist what's blocking each test and
// where to go next.
function TestAction({
  status,
  testRequestId,
  visitId,
  paid,
  preferredMedium,
  consentOnFile,
  gateRequired,
  hasPdf,
}: TestActionProps) {
  if (status === "ready_for_release") {
    return (
      <ReleaseButton
        testRequestId={testRequestId}
        visitId={visitId}
        paid={paid}
        preferredMedium={preferredMedium}
        consentOnFile={consentOnFile}
        gateRequired={gateRequired}
      />
    );
  }

  if (status === "requested" || status === "in_progress") {
    const hint = status === "requested" ? "Awaiting claim" : "Awaiting result";
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span className="text-xs text-[color:var(--color-brand-text-soft)]">
          {hint}
        </span>
        <Link
          href={`/staff/queue/${testRequestId}`}
          className="text-xs font-bold text-[color:var(--color-brand-cyan)] hover:underline"
        >
          Open in queue →
        </Link>
      </div>
    );
  }

  if (status === "result_uploaded") {
    return (
      <span className="text-xs text-[color:var(--color-brand-text-soft)]">
        Awaiting sign-off
      </span>
    );
  }

  if (status === "released") {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span className="text-xs font-semibold text-emerald-700">
          Released ✓
        </span>
        {hasPdf ? (
          <a
            href={`/staff/results/${testRequestId}/pdf`}
            target="_blank"
            rel="noopener"
            className="text-xs font-bold text-[color:var(--color-brand-cyan)] hover:underline"
          >
            View PDF →
          </a>
        ) : null}
      </div>
    );
  }

  if (status === "cancelled") {
    return (
      <span className="text-xs text-[color:var(--color-brand-text-soft)]">
        —
      </span>
    );
  }

  return null;
}
