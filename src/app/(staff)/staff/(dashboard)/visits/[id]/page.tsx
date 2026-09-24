import { ROUTE_NAME } from "@/lib/staff/route-names";
import { cache } from "react";
import { detailMetadata } from "@/lib/staff/detail-metadata";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { formatPhp } from "@/lib/marketing/format";
import { manilaDate, manilaDateTime } from "@/lib/dates/manila";
import {
  canActOnResult,
  canSeeLine,
  roleCanActOnResults,
} from "@/lib/visits/line-visibility";
import { ReleaseButton } from "./release-button";
import { ReleaseAllButton } from "./release-all-button";
import { ReleasePackageHeaderButton } from "./release-package-header-button";
import { MarkDoneButton } from "./mark-done-button";
import { SelectionProvider } from "./selection-context";
import { RowSelectCheckbox } from "./row-select-checkbox";
import { BulkActionBar } from "./bulk-action-bar";
import { UndoReleaseDialog } from "./undo-release-dialog";
import { WaiveBalanceDialog } from "./waive-balance-dialog";
import { AttendingPhysicianDialog } from "./attending-physician-dialog";
import { VoidPaymentDialog } from "../../payments/[id]/void/void-payment-dialog";
import { countResultViews } from "@/lib/results/viewed-count";
import { isConsentGateRequired, getPatientConsentState } from "@/lib/consent/gate";
import { paymentStatusLabel } from "@/lib/ui/payment-status";
import { Panel } from "@/components/ui/panel";
import {
  testDeletability,
  visitDeletability,
  hasOpenHmoClaim,
  QUEUE_DELETE_ROLES,
} from "@/lib/visits/deletion";
import {
  CONSULT_ONLY_RECEIPT_NOTE,
  shouldPrintReceipt,
} from "@/lib/visits/receipt-policy";
import { isDoctorKind } from "@/lib/visits/order-lines";
import { moneySettled } from "@/lib/visits/money-settled";
import { canManuallyReleasePackageHeader } from "@/lib/visits/package-header-release";
import { QueueDeleteDialog } from "@/components/staff/queue-delete-dialog";
import { ReissuePinButton } from "@/components/staff/reissue-pin-button";
import { handedBack } from "@/lib/queue/claim-remarks";
import { fetchClaimEvents } from "@/lib/queue/fetch-claim-events";
import { HandedBackBadge } from "@/components/staff/claim-remarks-list";

// Share the existing header lookup with metadata within this request.
const loadDetail = cache(async (id: string) => {
  const supabase = await createClient();
  return supabase
    .from("visits")
    .select(
      `
        id, visit_number, visit_date, payment_status,
        total_php, paid_php, notes, created_at,
        deleted_at, deleted_by, delete_reason,
        visit_group_id,
        hmo_provider_id, hmo_approval_date, hmo_authorization_no,
        attending_physician_id,
        patients!inner ( id, drm_id, first_name, last_name, preferred_release_medium ),
        hmo_providers ( id, name ),
        physicians ( id, full_name )
      `,
    )
    .eq("id", id)
    .maybeSingle();
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  await requireActiveStaff();
  const { id } = await params;
  return detailMetadata(ROUTE_NAME["/staff/visits/[id]"], async () => {
    const { data, error } = await loadDetail(id);
    return error || !data ? null : data.visit_number;
  });
}

interface Props {
  params: Promise<{ id: string }>;
  // `created=consult` is set by the create action when it skips the receipt
  // for a consultation-only visit (item 1 / decision 4).
  searchParams: Promise<{ created?: string }>;
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

// Mirrors the payment form's METHODS list (payments/new/payment-form.tsx) —
// every method the form offers must have an entry here, or the raw enum
// value shows on this page's payment tables (M6). `hmo` / `bpi` / `maybank`
// aren't offered by the counter form but can exist on legacy/imported rows.
const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  gcash: "GCash",
  maya: "Maya",
  card: "Card",
  bank_transfer: "Bank transfer",
  gift_code: "Gift code",
  hmo: "HMO",
  bpi: "BPI",
  maybank: "Maybank",
};

export default async function VisitDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { created } = await searchParams;
  const session = await requireActiveStaff();
  const isAdmin = session.role === "admin";
  const supabase = await createClient();

  const { data: visit } = await loadDetail(id);

  if (!visit) notFound();

  let sibling: { id: string; visit_number: string; is_doctor: boolean } | null = null;
  if (visit.visit_group_id) {
    const { data: sibs } = await supabase
      .from("visits")
      .select("id, visit_number, test_requests ( services ( kind ) )")
      .eq("visit_group_id", visit.visit_group_id)
      .neq("id", visit.id)
      // Don't link to a sibling that was itself deleted from the queue.
      .is("deleted_at", null);
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
  const attendingPhysician = Array.isArray(visit.physicians)
    ? visit.physicians[0]
    : visit.physicians;

  // Consent release-gate state for this patient. When the gate is on and
  // consent is missing, the Release button is hard-disabled (the DB trigger
  // would reject the release anyway). When off, missing consent only shows a
  // soft amber warning.
  const [gateRequired, consent] = await Promise.all([
    isConsentGateRequired(),
    getPatientConsentState(patient.id),
  ]);

  const [{ data: tests }, { data: payments }, { data: discountRows }, { data: physicians }] =
    await Promise.all([
      supabase
        .from("test_requests")
        .select(
          `
          id, status, requested_at, completed_at, released_at, release_medium,
          base_price_php, discount_kind, discount_amount_php, final_price_php,
          clinic_fee_php, doctor_pf_php,
          procedure_description, hmo_approved_amount_php,
          deleted_at, deleted_by, delete_reason,
          parent_id, is_package_header, package_completed_at,
          hmo_claim_items ( batch_voided ),
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
      // Labels for recorded discount codes — includes retired (inactive) rows
      // so historical lines still render their name.
      supabase.from("discount_types").select("code, label"),
      // Active physicians for the "Assign/Change physician" picker — same
      // roster + ordering as the new-visit form's attending-physician select.
      supabase
        .from("physicians")
        .select("id, full_name")
        .eq("is_active", true)
        .order("full_name", { ascending: true }),
    ]);

  const discountLabelByCode = new Map(
    (discountRows ?? []).map((d) => [d.code, d.label]),
  );

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

  // "handed back" chip: tests that were unclaimed at least once. Read through
  // queue_claim_remarks (0160) on the signed-in client — it answers only a
  // lab role (admin/pathologist/medtech/xray); reception gets nothing, and
  // reception sees no test rows on this page anyway.
  const claimEvents = await fetchClaimEvents(supabase, allTestIds);
  const handedBackFor = (id: string) => handedBack(claimEvents.get(id) ?? []);

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

  // Item 1 / decision 4: no receipt for a consultation-only visit. Deleted
  // lines don't count — a visit whose lab line was removed from the queue is
  // a consultation visit now.
  // Mirrors the role check inside reissuePatientPinAction.
  const canIssuePin = session.role === "reception" || session.role === "admin";
  const activeTestKinds = (tests ?? [])
    .filter((t) => t.deleted_at === null)
    .map((t) => (Array.isArray(t.services) ? t.services[0] : t.services))
    .map((svc) => svc?.kind)
    .filter((kind): kind is string => Boolean(kind));
  const printsReceipt = shouldPrintReceipt(activeTestKinds);
  // Item 23 gap 3: the release trigger (P0034) requires an attending
  // physician for doctor lines that accrue PF (zero-PF lines are exempt
  // since 0131 — nobody to accrue to). A visit with PF-carrying doctor
  // lines and no physician set is the dead end this UI fixes — surface
  // the CTA loudly. Zero-PF doctor lines still show the section so the
  // physician can be recorded, just without the release-blocked warning.
  const hasDoctorLines = activeTestKinds.some(isDoctorKind);
  const hasPfDoctorLines = (tests ?? [])
    .filter((t) => t.deleted_at === null)
    .some((t) => {
      const svc = Array.isArray(t.services) ? t.services[0] : t.services;
      return svc?.kind != null && isDoctorKind(svc.kind) && Number(t.doctor_pf_php ?? 0) > 0;
    });
  // Mirrors the role gate inside setVisitAttendingPhysician.
  const canAssignPhysician = session.role === "reception" || session.role === "admin";
  // A6: RLS denies medtech/pathologist/xray_technician any access to
  // `payments` (migration 0001: "payments: reception/admin manage") — those
  // roles never have a payment row to see or void. Mirrors canVoidPayment in
  // payments/[id]/void/actions.ts (same role pair).
  const canSeePayments = session.role === "reception" || session.role === "admin";

  // Two different questions, deliberately kept apart:
  //   isPaid     — does the counter still have money to collect? Drives the
  //                admin "waive balance" escape hatch.
  //   canRelease — may results leave the building? Mirrors the DB trigger
  //                enforce_payment_before_release (0133), which passes an HMO
  //                visit while it is still unpaid: the receivable is booked at
  //                release, so waiting for payment would deadlock it.
  const isPaid = visit.payment_status === "paid" || visit.payment_status === "waived";
  const canRelease = moneySettled({
    payment_status: visit.payment_status,
    hmo_provider_id: visit.hmo_provider_id,
  });
  const balance = Number(visit.total_php) - Number(visit.paid_php);
  const activePayments = (payments ?? []).filter((p) => !p.voided_at);
  const voidedPayments = (payments ?? []).filter((p) => p.voided_at);

  const visitDeleted = visit.deleted_at !== null;
  const canManageDeletion = QUEUE_DELETE_ROLES.has(session.role);
  const canDeleteVisit = visitDeletability(session.role, {
    payment_status: visit.payment_status,
    deleted_at: visit.deleted_at,
    test_statuses: (tests ?? [])
      .filter((t) => t.deleted_at === null)
      .map((t) => t.status),
    // Unfiltered on deleted_at, unlike test_statuses above — the P0050 trigger
    // reaches every line of the visit, since a line deleted earlier whose
    // claim is still open is exactly the receivable it protects.
    has_open_hmo_claim: (tests ?? []).some((t) =>
      hasOpenHmoClaim(t.hmo_claim_items),
    ),
  }).ok;

  // See-vs-act gate (owner decision, 2026-09-15 — reverses go-live "A4").
  // Reception SEES every bill line — name, code, price, discount, status —
  // because it enters and collects the bill; it never sees the RESULT (that
  // is the separate canActOnRow gate on the result-side controls below).
  // medtech sees only its own lab bench, xray_technician only imaging, and
  // admin + pathologist see everything. Package headers are visible if ANY
  // of their components are visible — we don't want a half-visible package.
  type SectionRow = {
    services: { section?: string | null } | { section?: string | null }[] | null;
  };
  const rowSection = (r: SectionRow): string | null | undefined => {
    const svc = Array.isArray(r.services) ? r.services[0] : r.services;
    return svc?.section;
  };
  const canSeeRow = (r: SectionRow) => canSeeLine(session.role, rowSection(r));
  const canActOnRow = (r: SectionRow) =>
    canActOnResult(session.role, rowSection(r));
  // A4 (go-live), still true under the see/act split: soft-deleted lines
  // (0125) leave the operational pipeline entirely and render in their own
  // "Deleted entries" panel below with a Restore action — but RLS on
  // test_requests is role-only, NOT section-aware (0023), so without this
  // filter the panel would print every deleted test's real service name and
  // price to every lab role outside its own section. Reception IS allowed to
  // see its own deleted bill lines here (it deletes them from the queue), so
  // this filter is now load-bearing only for medtech/xray_technician, not for
  // reception. Apply canSeeRow() row by row, exactly like the live table one
  // block above does for rawRows.
  const deletedTestRows = (tests ?? [])
    .filter((t) => t.deleted_at !== null)
    .filter((t) => canSeeRow(t));
  const rawRows = (tests ?? []).filter((t) => t.deleted_at === null);
  // First pass: mark which parent_ids have at least one visible component.
  const visibleParents = new Set<string>();
  // …and which have at least one component this role may ACT on. A package
  // header must never be gated on its OWN section: a header's
  // services.section is the literal "package", which appears in no role's
  // allowed-section list, so gating the header directly would strip bulk
  // package release from medtech and xray_technician even for a package made
  // entirely of their own bench's work. The header's authority comes from its
  // components, exactly as its visibility does one line above.
  const actionableParents = new Set<string>();
  for (const r of rawRows) {
    if (!r.parent_id) continue;
    if (canSeeRow(r)) visibleParents.add(r.parent_id);
    if (canActOnRow(r)) actionableParents.add(r.parent_id);
  }
  const allRows = rawRows.filter((r) => {
    if (r.is_package_header) return visibleParents.has(r.id);
    return canSeeRow(r);
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

  // Patient viewed/downloaded counts for every visible released row — drives
  // the loud "already viewed" warning on the per-row undo dialog and the bulk
  // bar. Headers are excluded: they carry no undo affordance (the 0110
  // cascade owns header flips) and package downloads are attributed to
  // components via merged_component_ids/test_request_ids.
  const releasedRowIds = allRows
    .filter((r) => !r.is_package_header && r.status === "released")
    .map((r) => r.id);
  const viewedCountByTrId = new Map<string, number>(
    await Promise.all(
      releasedRowIds.map(
        async (trId) => [trId, await countResultViews(trId)] as const,
      ),
    ),
  );
  const viewedCountRecord = Object.fromEntries(viewedCountByTrId);

  // Names for the "deleted by" lines (banner + deleted-entries panel). The
  // service-role client resolves them the same way the PF badge block does.
  const deleterIds = Array.from(
    new Set(
      [visit.deleted_by, ...deletedTestRows.map((t) => t.deleted_by)].filter(
        (v): v is string => !!v,
      ),
    ),
  );
  const deleterNameById = new Map<string, string>();
  if (deleterIds.length > 0) {
    const { data: deleters } = await createAdminClient()
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", deleterIds);
    for (const d of deleters ?? []) deleterNameById.set(d.id, d.full_name);
  }

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
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
            {manilaDate(visit.visit_date)}
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
          <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {patient.last_name}, {patient.first_name}
          </h1>
          <p className="mt-1 text-xs">
            {consent.current ? (
              <>
                <span className="text-green-700">Privacy consent on file</span>
                {" · "}
                <Link
                  href={`/staff/patients/${patient.id}/consent/signed`}
                  target="_blank"
                  className="font-bold text-[color:var(--color-brand-cyan)] hover:underline"
                >
                  View signed form
                </Link>
              </>
            ) : (
              <>
                <span className="text-amber-700">Privacy consent not on file</span>
                {" · "}
                <Link
                  href={`/staff/patients/${patient.id}#consent`}
                  className="font-bold text-[color:var(--color-brand-cyan)] hover:underline"
                >
                  Capture it on the patient page
                </Link>
              </>
            )}
          </p>
        </div>
        {visitDeleted ? null : (
          <div className="flex flex-wrap items-center gap-2">
            {printsReceipt ? (
              <Link
                href={`/staff/visits/${visit.id}/receipt`}
                className="rounded-md border border-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-navy)] hover:text-white"
              >
                Receipt
              </Link>
            ) : canIssuePin ? (
              // No receipt to carry the PIN (item 1) — this is the deliberate
              // path for a consultation patient who wants portal access.
              <ReissuePinButton
                patientId={patient.id}
                visitId={visit.id}
                label="Issue portal PIN"
                confirmText="Issue a Secure PIN for this visit and print the portal slip? Any earlier PIN for this visit stops working immediately."
              />
            ) : null}
            {canSeePayments ? (
              session.role === "reception" && visit.hmo_provider_id != null ? (
                // An HMO patient never pays at the counter — the claim is
                // booked as a receivable when the tests release, then settled
                // through the HMO claims workflow, not by reception taking a
                // payment here. Offering the link on a pure HMO visit was a
                // door to nothing it could ever complete. Admin keeps the
                // link below on purpose: an HMO claim resolved as "Bill
                // patient" legitimately moves the balance onto the patient,
                // and admin is who collects it at the counter.
                <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                  Billed to {hmo?.name ?? "HMO"} — settled through HMO claims
                </p>
              ) : (
                <Link
                  href={`/staff/payments/new?visit_id=${visit.id}`}
                  className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
                >
                  Record payment
                </Link>
              )
            ) : null}
            {canDeleteVisit ? (
              <QueueDeleteDialog
                visitId={visit.id}
                mode="delete"
                entryLabel={`visit #${visit.visit_number}`}
              />
            ) : null}
          </div>
        )}
      </header>

      {created === "consult" && !visitDeleted ? (
        <section className="mt-4 rounded-xl border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Visit created
          </p>
          <p className="mt-1 text-sm text-[color:var(--color-brand-navy)]">
            {CONSULT_ONLY_RECEIPT_NOTE} Send the patient in to the doctor —
            record the payment here when they settle at the counter.
            {canIssuePin
              ? " If they need the online portal anyway, use “Issue portal PIN” above."
              : ""}
          </p>
        </section>
      ) : null}

      {visitDeleted ? (
        <section className="mt-6 rounded-xl border border-red-200 bg-red-50 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-red-700">
                Deleted from the queue
              </p>
              <p className="mt-1 text-sm text-red-900">
                {visit.deleted_by
                  ? (deleterNameById.get(visit.deleted_by) ?? "Staff")
                  : "Staff"}{" "}
                deleted this visit
                {visit.deleted_at
                  ? ` on ${manilaDateTime(visit.deleted_at)}`
                  : ""}
                . Nothing is billed and it no longer appears in any queue.
              </p>
              {visit.delete_reason ? (
                <p className="mt-1 text-sm text-red-900">
                  Reason: {visit.delete_reason}
                </p>
              ) : null}
            </div>
            {canManageDeletion ? (
              <QueueDeleteDialog
                visitId={visit.id}
                mode="restore"
                entryLabel={`visit #${visit.visit_number}`}
              />
            ) : null}
          </div>
        </section>
      ) : null}

      {canSeePayments ? (
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
                {paymentStatusLabel(visit.payment_status)}
              </span>
            </p>
            {isAdmin && !isPaid && !visitDeleted && !visit.hmo_provider_id ? (
              <WaiveBalanceDialog
                visitId={visit.id}
                balanceLabel={formatPhp(balance > 0 ? balance : 0)}
              />
            ) : null}
          </div>
        </section>
      ) : null}

      {hasDoctorLines || attendingPhysician ? (
        <section className="mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                Attending physician
              </p>
              <p className="mt-1 font-semibold text-[color:var(--color-brand-navy)]">
                {attendingPhysician?.full_name ?? "— None set —"}
              </p>
            </div>
            {canAssignPhysician && !visitDeleted ? (
              <AttendingPhysicianDialog
                visitId={visit.id}
                currentPhysicianId={visit.attending_physician_id}
                currentPhysicianName={attendingPhysician?.full_name ?? null}
                physicians={physicians ?? []}
                prominent={!attendingPhysician && hasPfDoctorLines}
              />
            ) : null}
          </div>
          {!attendingPhysician && hasPfDoctorLines ? (
            <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
              This visit has consult/procedure lines that accrue doctor PF
              but no attending physician on record — releasing them will be
              blocked until one is assigned.
            </p>
          ) : null}
          <p className="mt-2 text-[10px] text-[color:var(--color-brand-text-soft)]">
            Changing the physician affects PF accrual only for lines released
            after the change — already-released lines keep their recorded PF.
          </p>
        </section>
      ) : null}

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

      <SelectionProvider>
      <section className="mt-8">
        <h2 className="mb-3 font-heading text-xl font-extrabold text-[color:var(--color-brand-navy)]">
          Tests
        </h2>

        {packageHeaders.length > 0 ? (
          <>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Packages
            </h3>
            <div className="mb-4 space-y-4">
              {packageHeaders.map((h) => {
                const svc = Array.isArray(h.services) ? h.services[0] : h.services;
                if (!svc) return null;
                const finalPrice =
                  h.final_price_php != null
                    ? Number(h.final_price_php)
                    : Number(svc.price_php);
                const components = componentsByParent.get(h.id) ?? [];
                const readyCount = components.filter(
                  (c) => c.status === "ready_for_release",
                ).length;
                return (
                  <Panel key={h.id} className="p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <Link
                        href={`/staff/queue/${h.id}`}
                        className="min-w-0 hover:opacity-90"
                      >
                        <p className="font-mono text-[10px] uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                          {svc.code} · Package
                        </p>
                        <p className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
                          {svc.name}
                        </p>
                        {h.package_completed_at ? (
                          <p className="mt-1 text-[11px] text-emerald-700">
                            Completed{" "}
                            {manilaDateTime(h.package_completed_at)}
                          </p>
                        ) : null}
                      </Link>
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
                        {readyCount >= 2 &&
                        !visitDeleted &&
                        actionableParents.has(h.id) ? (
                          <ReleaseAllButton
                            headerId={h.id}
                            visitId={visit.id}
                            moneySettled={canRelease}
                            consentOnFile={consent.current}
                            gateRequired={gateRequired}
                            readyCount={readyCount}
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
                        ) : null}
                        {/* A3 (go-live): admin-only escape hatch for a header
                            stuck at ready_for_release with every component
                            already terminal — the Leg A trigger (0109)
                            normally auto-releases it and didn't. */}
                        {isAdmin &&
                        !visitDeleted &&
                        canManuallyReleasePackageHeader(h, components) ? (
                          <ReleasePackageHeaderButton
                            headerId={h.id}
                            visitId={visit.id}
                            moneySettled={canRelease}
                          />
                        ) : null}
                        {testDeletability(session.role, {
                          status: h.status,
                          deleted_at: null,
                          parent_id: h.parent_id,
                          visit_payment_status: visit.payment_status,
                          visit_deleted_at: visit.deleted_at,
                          // Deleting a header cascades to its components, so a
                          // component with an open claim raises P0050 at depth
                          // 2 and aborts the whole delete. Check both here or
                          // the button offers a delete the DB refuses.
                          has_open_hmo_claim:
                            hasOpenHmoClaim(h.hmo_claim_items) ||
                            components.some((c) =>
                              hasOpenHmoClaim(c.hmo_claim_items),
                            ),
                        }).ok ? (
                          <QueueDeleteDialog
                            visitId={visit.id}
                            testRequestIds={[h.id]}
                            mode="delete"
                            entryLabel={`the ${svc.name} package`}
                          />
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-3 overflow-x-auto rounded-lg border border-[color:var(--color-brand-bg-mid)]">
                      <table className="w-full text-sm">
                        {/* Visually hidden header: keeps the plan-mandated
                            6-column layout while giving screen readers
                            column context (esp. the "—" price cells). */}
                        <thead className="sr-only">
                          <tr>
                            <th scope="col">Select</th>
                            <th scope="col">Service</th>
                            <th scope="col">Base</th>
                            <th scope="col">Discount</th>
                            <th scope="col">Final</th>
                            <th scope="col">Status</th>
                            <th scope="col">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                          {components.length === 0 ? (
                            <tr>
                              <td
                                colSpan={7}
                                className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                              >
                                No components linked yet.
                              </td>
                            </tr>
                          ) : (
                            components.map((c) => {
                              const csvc = Array.isArray(c.services)
                                ? c.services[0]
                                : c.services;
                              if (!csvc) return null;
                              return (
                                <tr
                                  key={c.id}
                                  className="hover:bg-[color:var(--color-brand-bg)]"
                                >
                                  <td className="px-4 py-3">
                                    {visitDeleted || !canActOnRow(c) ? null : c.status ===
                                      "ready_for_release" ? (
                                      <RowSelectCheckbox
                                        testRequestId={c.id}
                                        eligibility="release"
                                        label={csvc.name}
                                      />
                                    ) : c.status === "released" ? (
                                      <RowSelectCheckbox
                                        testRequestId={c.id}
                                        eligibility="unrelease"
                                        label={csvc.name}
                                      />
                                    ) : null}
                                  </td>
                                  <td className="px-4 py-3">
                                    <Link
                                      href={`/staff/queue/${c.id}`}
                                      className="text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)] hover:underline"
                                    >
                                      {csvc.name}
                                    </Link>
                                    <p className="font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                                      {csvc.code}
                                      {/* Section cue (was on the old <ul> rows):
                                          also signals when a component belongs
                                          to another role's bench. */}
                                      <span className="ml-1 uppercase tracking-wider">
                                        {csvc.section ?? "—"}
                                      </span>
                                    </p>
                                    {c.release_medium && c.released_at ? (
                                      <p className="mt-1 text-[10px] text-emerald-700">
                                        Released via {c.release_medium}
                                      </p>
                                    ) : null}
                                  </td>
                                  <td className="px-4 py-3 text-right font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                                    —
                                  </td>
                                  <td className="px-4 py-3 text-right font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                                    —
                                  </td>
                                  <td className="px-4 py-3 text-right font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                                    —
                                  </td>
                                  <td className="px-4 py-3">
                                    <span
                                      className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                                        TEST_STATUS_STYLE[c.status] ?? ""
                                      }`}
                                    >
                                      {c.status.replace(/_/g, " ")}
                                    </span>
                                    <HandedBackBadge info={handedBackFor(c.id)} />
                                  </td>
                                  <td className="px-4 py-3 text-right">
                                    <TestAction
                                      size="compact"
                                      visitDeleted={visitDeleted}
                                      canAct={canActOnRow(c)}
                                      status={c.status}
                                      testRequestId={c.id}
                                      visitId={visit.id}
                                      moneySettled={canRelease}
                                      consentOnFile={consent.current}
                                      gateRequired={gateRequired}
                                      hasPdf={hasPdfByTrId.get(c.id) === true}
                                      kind={csvc.kind}
                                      viewedCount={viewedCountByTrId.get(c.id) ?? 0}
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
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </Panel>
                );
              })}
            </div>
          </>
        ) : null}

        {standalones.length > 0 ? (
          <h3 className="mb-2 mt-4 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Individual tests
          </h3>
        ) : null}

        <Panel className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-2 py-3">
                  <span className="sr-only">Select</span>
                </th>
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
                  ? discountLabelByCode.get(t.discount_kind) ?? t.discount_kind
                  : null;
                const isConsult = svc.kind === "doctor_consultation";
                const isProcedure = svc.kind === "doctor_procedure";
                return (
                  <tr
                    key={t.id}
                    className="hover:bg-[color:var(--color-brand-bg)]"
                  >
                    <td className="px-2 py-3">
                      {visitDeleted || !canActOnRow(t) ? null : t.status ===
                        "ready_for_release" ? (
                        <RowSelectCheckbox
                          testRequestId={t.id}
                          eligibility="release"
                          label={svc.name}
                        />
                      ) : t.status === "released" ? (
                        <RowSelectCheckbox
                          testRequestId={t.id}
                          eligibility="unrelease"
                          label={svc.name}
                        />
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      {/* A doctor line has no bench page to open: /staff/queue/<id>
                          is the lab worklist detail (claim, upload, key a result)
                          and now refuses a consultation outright. Linking one
                          there was a normal click that landed on the wrong screen,
                          so the name stays plain text for doctor work — the
                          actions it DOES have live in this row's own column. */}
                      {isConsult || isProcedure ? (
                        <span className="text-[color:var(--color-brand-navy)]">
                          {svc.name}
                        </span>
                      ) : (
                        <Link
                          href={`/staff/queue/${t.id}`}
                          className="text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)] hover:underline"
                        >
                          {svc.name}
                        </Link>
                      )}
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
                      {/* Deliberately shown to every role that can see this
                          row, reception included (Codex counter-review
                          corrected the earlier plan on this): reception
                          already TYPES both the clinic fee and the PF amount
                          in at intake (visits/new/visit-form.tsx, the consult
                          fee/clinic fee inputs on the line), so hiding the
                          split here would be theatre — it only ever repeats
                          numbers reception itself keyed in. */}
                      {(isConsult || isProcedure) &&
                      (t.clinic_fee_php != null || t.doctor_pf_php != null) ? (
                        <p className="mt-1 text-[10px] text-[color:var(--color-brand-text-soft)]">
                          Clinic fee {formatPhp(Number(t.clinic_fee_php ?? 0))} ·
                          PF {formatPhp(Number(t.doctor_pf_php ?? 0))}
                        </p>
                      ) : null}
                      {/* PF *payout* status stays admin-only — it's doctor-pay
                          data, not visit/result data (2026-09-10 PF audit). */}
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
                      <HandedBackBadge info={handedBackFor(t.id)} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <TestAction
                        visitDeleted={visitDeleted}
                        canAct={canActOnRow(t)}
                        status={t.status}
                        testRequestId={t.id}
                        visitId={visit.id}
                        moneySettled={canRelease}
                        consentOnFile={consent.current}
                        gateRequired={gateRequired}
                        hasPdf={hasPdfByTrId.get(t.id) === true}
                        kind={svc.kind}
                        viewedCount={viewedCountByTrId.get(t.id) ?? 0}
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
                      {testDeletability(session.role, {
                        status: t.status,
                        deleted_at: null,
                        parent_id: t.parent_id,
                        visit_payment_status: visit.payment_status,
                        visit_deleted_at: visit.deleted_at,
                        has_open_hmo_claim: hasOpenHmoClaim(t.hmo_claim_items),
                      }).ok ? (
                        <div className="mt-1.5 flex justify-end">
                          <QueueDeleteDialog
                            visitId={visit.id}
                            testRequestIds={[t.id]}
                            mode="delete"
                            entryLabel={svc.name}
                          />
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {standalones.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
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
        </Panel>
        {!canRelease ? (
          <p className="mt-3 text-xs text-[color:var(--color-brand-text-soft)]">
            ℹ️ Releases are blocked until the visit is paid or waived. HMO
            visits release straight away — the claim is booked as a
            receivable on release. The payment-gating trigger enforces this
            at the database level.
          </p>
        ) : null}
      </section>
      {visitDeleted || !roleCanActOnResults(session.role) ? null : (
        <BulkActionBar
          visitId={visit.id}
          moneySettled={canRelease}
          preferredMedium={
            (patient.preferred_release_medium ?? null) as
              | "physical"
              | "email"
              | "viber"
              | "gcash"
              | "pickup"
              | null
          }
          consentOnFile={consent.current}
          gateRequired={gateRequired}
          viewedCountById={viewedCountRecord}
        />
      )}
      </SelectionProvider>

      {deletedTestRows.length > 0 ? (
        <details className="mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] px-4 py-3">
          <summary className="cursor-pointer text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Deleted entries ({deletedTestRows.length})
          </summary>
          <ul className="mt-2 space-y-2 text-xs">
            {deletedTestRows.map((t) => {
              const svc = Array.isArray(t.services) ? t.services[0] : t.services;
              const price =
                t.final_price_php != null ? Number(t.final_price_php) : null;
              return (
                <li
                  key={t.id}
                  className="flex flex-wrap items-start justify-between gap-2 rounded-md bg-white px-3 py-2"
                >
                  <div>
                    <span className="font-semibold text-[color:var(--color-brand-text-mid)] line-through">
                      {svc?.name ?? "—"}
                    </span>
                    {t.is_package_header ? (
                      <span className="ml-1 text-[color:var(--color-brand-text-soft)]">
                        (package)
                      </span>
                    ) : t.parent_id ? (
                      <span className="ml-1 text-[color:var(--color-brand-text-soft)]">
                        (package component)
                      </span>
                    ) : null}
                    {price != null && price > 0 ? (
                      <span className="ml-2 font-mono text-[color:var(--color-brand-text-soft)] line-through">
                        {formatPhp(price)}
                      </span>
                    ) : null}
                    <p className="mt-0.5 text-[color:var(--color-brand-text-soft)]">
                      Deleted
                      {t.deleted_by
                        ? ` by ${deleterNameById.get(t.deleted_by) ?? "staff"}`
                        : ""}
                      {t.deleted_at
                        ? ` on ${manilaDateTime(t.deleted_at)}`
                        : ""}
                      {t.delete_reason ? ` — ${t.delete_reason}` : ""}
                    </p>
                  </div>
                  {/* Components ride their header's restore; a deleted visit
                      must be restored first (its own banner has the button). */}
                  {canManageDeletion && !visitDeleted && t.parent_id === null ? (
                    <QueueDeleteDialog
                      visitId={visit.id}
                      testRequestIds={[t.id]}
                      mode="restore"
                      entryLabel={svc?.name ?? "this entry"}
                      size="compact"
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}

      <section className="mt-8">
        <h2 className="mb-3 font-heading text-xl font-extrabold text-[color:var(--color-brand-navy)]">
          Payments
        </h2>
        <Panel className="overflow-x-auto">
          <table className="w-full text-sm">
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
                    {manilaDateTime(p.received_at)}
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
                    {/* A6: void is reception/admin-only by owner decision —
                        mirrors canVoidPayment in
                        payments/[id]/void/actions.ts, which gates the actual
                        write. RLS already keeps activePayments empty for
                        every other role, so this is defense-in-depth. */}
                    {canSeePayments ? (
                      <VoidPaymentDialog
                        paymentId={p.id}
                        amountLabel={formatPhp(p.amount_php)}
                      />
                    ) : null}
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
        </Panel>

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
                      voided {p.voided_at ? manilaDateTime(p.voided_at) : ""}
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
        className={`mt-1 font-heading text-2xl font-extrabold ${
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
  // A soft-deleted visit keeps live lines (0125's delete does not cascade to
  // test_requests), so the table still renders them — but none may be actioned.
  visitDeleted: boolean;
  // See-vs-act split (2026-09-15): may this role act on the RESULT behind
  // this line (canActOnRow in the caller, built on canActOnResult in
  // line-visibility.ts)? Reception can see every row but this is always
  // false for it — a lab role viewing a line outside its own section is the
  // other (defense-in-depth) way to land here, though canSeeRow already
  // keeps such rows off this role's table.
  canAct: boolean;
  testRequestId: string;
  visitId: string;
  moneySettled: boolean;
  preferredMedium: "physical" | "email" | "viber" | "gcash" | "pickup" | null;
  consentOnFile: boolean;
  gateRequired: boolean;
  hasPdf?: boolean;
  kind: string;
  // Patient viewed/downloaded count for a released row — drives the undo
  // dialog's "already viewed" warning.
  viewedCount: number;
  // "compact" is used inside package-component rows, which are denser than
  // the standalone tests table.
  size?: "default" | "compact";
}

// Renders a context-appropriate cell for the Action column on the visit
// detail tests table. Tells the receptionist what's blocking each test and
// where to go next.
function TestAction({
  status,
  visitDeleted,
  canAct,
  testRequestId,
  visitId,
  moneySettled,
  preferredMedium,
  consentOnFile,
  gateRequired,
  hasPdf,
  kind,
  viewedCount,
  size = "default",
}: TestActionProps) {
  const sizeCls = size === "compact" ? "text-[10px]" : "text-xs";

  // Nothing on a deleted visit is actionable. Release, undo and mark-done all
  // refuse one server-side now (refuseIfVisitDeleted in ./actions.ts), and the
  // release controls would otherwise disable themselves with the money
  // tooltip — the wrong reason entirely. The red "Deleted from the queue"
  // banner above is the explanation; this cell goes quiet like "cancelled".
  if (visitDeleted) {
    return (
      <span className={`${sizeCls} text-[color:var(--color-brand-text-soft)]`}>
        —
      </span>
    );
  }

  // Reception is the role this branch exists for (see-vs-act split,
  // 2026-09-15): it sees every bill line but may not act on the result
  // behind it. Render a read-only status hint ONLY — reusing the same words
  // this column already shows for each status — with none of MarkDoneButton,
  // ReleaseButton, UndoReleaseDialog, the "View PDF →" anchor, or the "Open
  // in queue →" bench link. Those are all doors into a result reception must
  // not have; the status chip in the row plus this hint is all it gets.
  if (!canAct) {
    const hint =
      status === "requested"
        ? "Awaiting claim"
        : status === "in_progress"
          ? "Awaiting result"
          : status === "result_uploaded"
            ? "Awaiting sign-off"
            : status === "released"
              ? "Released ✓"
              : status === "cancelled"
                ? "—"
                // ready_for_release has no distinct Action-column word today
                // (only a button) — reuse the same humanized text the status
                // badge already shows for it.
                : status.replace(/_/g, " ");
    return (
      <span
        className={`${sizeCls} ${
          status === "released"
            ? "font-semibold text-emerald-700"
            : "text-[color:var(--color-brand-text-soft)]"
        }`}
      >
        {hint}
      </span>
    );
  }

  // Kind is checked BEFORE status. A doctor line is completed with "Mark
  // done" (markDoctorLineDoneAction) in every state it can be actioned from,
  // and that action deliberately sends no patient notification — there is no
  // result to collect.
  //
  // Keying this branch on status alone leaked a real notification: undoing a
  // released consultation (to correct the attending physician, say) parks it
  // at `ready_for_release`, which used to fall into the generic Release
  // button below. Pressing it called releaseTestAction → notifyResultReleased
  // unconditionally, and the patient was emailed "Your DRMed lab result is
  // ready" for a doctor visit that produced no result and no file to open.
  // (The literal comparison rather than isDoctorKind() is what narrows `kind`
  // to the union MarkDoneButton accepts.)
  if (kind === "doctor_consultation" || kind === "doctor_procedure") {
    if (
      status === "ready_for_release" ||
      status === "requested" ||
      status === "in_progress"
    ) {
      return (
        <MarkDoneButton
          testRequestId={testRequestId}
          visitId={visitId}
          moneySettled={moneySettled}
          kind={kind}
        />
      );
    }
  }

  if (status === "ready_for_release") {
    return (
      <ReleaseButton
        testRequestId={testRequestId}
        visitId={visitId}
        moneySettled={moneySettled}
        preferredMedium={preferredMedium}
        consentOnFile={consentOnFile}
        gateRequired={gateRequired}
        size={size}
      />
    );
  }

  if (status === "requested" || status === "in_progress") {
    const hint = status === "requested" ? "Awaiting claim" : "Awaiting result";
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span className={`${sizeCls} text-[color:var(--color-brand-text-soft)]`}>
          {hint}
        </span>
        <Link
          href={`/staff/queue/${testRequestId}`}
          className={`${sizeCls} font-bold text-[color:var(--color-brand-cyan)] hover:underline`}
        >
          Open in queue →
        </Link>
      </div>
    );
  }

  if (status === "result_uploaded") {
    return (
      <span className={`${sizeCls} text-[color:var(--color-brand-text-soft)]`}>
        Awaiting sign-off
      </span>
    );
  }

  if (status === "released") {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span className={`${sizeCls} font-semibold text-emerald-700`}>
          Released ✓
        </span>
        {hasPdf ? (
          <a
            href={`/staff/results/${testRequestId}/pdf`}
            target="_blank"
            rel="noopener"
            className={`${sizeCls} font-bold text-[color:var(--color-brand-cyan)] hover:underline`}
          >
            View PDF →
          </a>
        ) : null}
        {/* Headers never reach TestAction (only components + standalones
            render it), so every released row here may offer Undo — the 0110
            cascade flips the header when its last component is undone. */}
        <UndoReleaseDialog
          testRequestId={testRequestId}
          visitId={visitId}
          viewedCount={viewedCount}
          size={size}
        />
      </div>
    );
  }

  if (status === "cancelled") {
    return (
      <span className={`${sizeCls} text-[color:var(--color-brand-text-soft)]`}>
        —
      </span>
    );
  }

  return null;
}
