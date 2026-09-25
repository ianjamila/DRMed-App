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
  canViewResultPdf,
  roleCanActOnResults,
} from "@/lib/visits/line-visibility";
import { ReleaseButton } from "./release-button";
import { fetchSharedReportTestIds } from "@/lib/visits/shared-report-links";
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
import { EditPaymentDialog } from "../../payments/[id]/edit/edit-payment-dialog";
import { MovePaymentDialog } from "../../payments/[id]/move/move-payment-dialog";
import { paymentEditability } from "@/lib/visits/payment-edit";
import { linkPayments, paymentMethodLabel as methodLabel } from "@/lib/visits/payment-history";
import {
  PAYMENT_HISTORY_SELECT,
  loadLinkedPayments,
  type LoadedPayment,
} from "@/lib/visits/payment-history-load";
import { PaymentArrivalNote, PaymentChangeEntry } from "@/components/staff/payment-change-note";
import { countResultViews } from "@/lib/results/viewed-count";
import { isConsentGateRequired, getPatientConsentState } from "@/lib/consent/gate";
import { paymentStatusLabel } from "@/lib/ui/payment-status";
import { Panel } from "@/components/ui/panel";
import {
  testDeletability,
  visitDeletability,
  hasOpenHmoClaim,
  QUEUE_DELETE_ROLES,
  type ResultLinkRow,
} from "@/lib/visits/deletion";
import { foldEditNotes, type EditNoteTestRow } from "@/lib/results/edit-note";
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
import { PrintResultButton } from "@/components/staff/print-result-button";
import { printAllFiles, resultPdfStates } from "@/lib/results/pdf-availability";
import { fetchPrintSummaries } from "@/lib/results/print-history";
import type { PrintSummary } from "@/lib/results/print-summary";
import { PrintedNote } from "@/components/staff/printed-note";

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
          services!inner (
            id, code, name, kind, section, price_php,
            report_group_id, report_groups ( name )
          )
        `,
        )
        .eq("visit_id", id)
        .order("is_package_header", { ascending: false })
        .order("requested_at", { ascending: true }),
      supabase
        .from("payments")
        .select(PAYMENT_HISTORY_SELECT)
        .eq("visit_id", id)
        .order("received_at", { ascending: false })
        .order("id", { ascending: true })
        .returns<LoadedPayment[]>(),
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

  // Which test_requests have a result PDF the staff PDF route would stream,
  // and whether all of it is released (a consolidated chemistry PDF is shared
  // by the panel). Read once for the page, so TestAction can draw "Print
  // result" / "View PDF" without each row firing its own join.
  const allTestIds = (tests ?? []).map((t) => t.id);
  const pdfStates = await resultPdfStates(supabase, allTestIds);
  // "Printed … by …" under each Print button — per FILE (a shared chemistry
  // PDF printed from any member counts for all of them), read off the audit
  // log as a derived fact only.
  const printSummaries = await fetchPrintSummaries(
    [...pdfStates.values()].map((s) => ({ resultId: s.resultId, version: s.version })),
    { patientId: patient.id },
  );
  const printedFor = (testId: string) => {
    const state = pdfStates.get(testId);
    return state ? printSummaries.get(state.resultId) : undefined;
  };
  // "Print all released results": the distinct released reports this role
  // may print, combined by visits/[id]/results-pdf. Offered from two up —
  // one report is just its line's own Print button.
  const printAllCount = printAllFiles(
    session.role,
    (tests ?? []).map((t) => {
      const svc = Array.isArray(t.services) ? t.services[0] : t.services;
      return {
        id: t.id,
        status: t.status,
        section: svc?.section ?? null,
        kind: svc?.kind ?? null,
        deleted: t.deleted_at !== null,
      };
    }),
    pdfStates,
  ).length;

  // "handed back" chip: tests that were unclaimed at least once. Read through
  // queue_claim_remarks (0160) on the signed-in client — it answers only a
  // lab role (admin/pathologist/medtech/xray); reception gets nothing, and
  // the chip is a bench detail reception has no use for.
  const claimEvents = await fetchClaimEvents(supabase, allTestIds);
  const handedBackFor = (id: string) => handedBack(claimEvents.get(id) ?? []);

  // Which tests sit on a FINISHED COMBINED report (0172, P0067/§5/§6.1) —
  // one junction query keyed by test_request_id feeds the delete-guard
  // mirror (has_shared_report below), the whole-report undo scope shown to
  // the operator before they confirm, and the per-result amendment data the
  // Edited note needs. No N+1.
  const resultLinkRows: ResultLinkRow[] = [];
  const resultIdByTrId = new Map<string, string>();
  const amendedAtByTrId = new Map<string, string | null>();
  const amendmentCountByTrId = new Map<string, number>();
  if (allTestIds.length > 0) {
    const { data: pdfLinks } = await supabase
      .from("result_test_requests")
      .select(
        "test_request_id, result_id, results!inner ( storage_path, amended_at, amendment_count )",
      )
      .in("test_request_id", allTestIds);
    type ResultCols = {
      storage_path: string | null;
      amended_at: string | null;
      amendment_count: number;
    };
    for (const link of pdfLinks ?? []) {
      const res = (link as { results: ResultCols | ResultCols[] | null }).results;
      const resolved = Array.isArray(res) ? res[0] : res;
      const trId = link.test_request_id as string;
      const resultId = link.result_id as string;
      resultLinkRows.push({
        test_request_id: trId,
        result_id: resultId,
        storage_path: resolved?.storage_path ?? null,
      });
      resultIdByTrId.set(trId, resultId);
      amendedAtByTrId.set(trId, resolved?.amended_at ?? null);
      amendmentCountByTrId.set(trId, resolved?.amendment_count ?? 0);
    }
  }
  // Counted like P0067: members off this visit's live list (a deleted
  // member) still make the report shared.
  const sharedReportIds = await fetchSharedReportTestIds(supabase, allTestIds);

  // Full report membership (ANY status) keyed by result id, and each
  // member's group name — used only to size/word the whole-report undo
  // warning shown before the operator confirms (0172 §5/§9 R6). Display
  // only: undoReleaseSelectedAction re-derives and enforces the real scope
  // server-side.
  const membersByResultId = new Map<string, string[]>();
  for (const l of resultLinkRows) {
    const members = membersByResultId.get(l.result_id) ?? [];
    members.push(l.test_request_id);
    membersByResultId.set(l.result_id, members);
  }
  const reportGroupNameByTrId = new Map<string, string | null>();
  for (const t of tests ?? []) {
    const svc = Array.isArray(t.services) ? t.services[0] : t.services;
    const rg = svc
      ? Array.isArray(svc.report_groups)
        ? svc.report_groups[0]
        : svc.report_groups
      : null;
    reportGroupNameByTrId.set(t.id, rg?.name ?? null);
  }
  const reportScopeByTrId: Record<string, { memberIds: string[]; label: string }> = {};
  for (const members of membersByResultId.values()) {
    if (members.length <= 1) continue;
    const scope = {
      memberIds: members,
      label: reportGroupNameByTrId.get(members[0]) ?? "combined",
    };
    for (const trId of members) reportScopeByTrId[trId] = scope;
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
  // Edit / Move (0161) link a corrected row to the original it voided. A move
  // puts the other half on ANOTHER visit, so load those rows too, or the
  // history here would call a moved payment "deleted".
  const [linkedPayments, otherVisitsRes] = canSeePayments
    ? await Promise.all([
        loadLinkedPayments(supabase, payments ?? []),
        // Quick picks for Move: this patient's other live visits. Uncapped on
        // purpose — the most any patient has on prod is 72.
        supabase
          .from("visits")
          .select("id, visit_number, visit_date, total_php, paid_php")
          .eq("patient_id", patient.id)
          .is("deleted_at", null)
          .neq("id", visit.id)
          .order("visit_date", { ascending: false })
          .order("id", { ascending: true }),
      ])
    : [[] as LoadedPayment[], { data: [] as { id: string; visit_number: string; visit_date: string; total_php: number; paid_php: number }[] }];
  const paymentLinks = linkPayments([...(payments ?? []), ...linkedPayments]);
  const otherVisits = (otherVisitsRes.data ?? []).map((v) => ({
    id: v.id,
    visitNumber: v.visit_number,
    visitDate: v.visit_date,
    totalPhp: Number(v.total_php),
    paidPhp: Number(v.paid_php),
  }));

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
  // Widen to every visible combined-report member (any status), not just
  // currently-released ones — a member released-then-undone earlier can
  // still carry a real view count, and the whole-report undo warning (0172
  // §5/§9 R6) aggregates over the report, not just what's released today.
  const visibleRowIds = new Set(allRows.map((r) => r.id));
  const viewedCountIds = new Set<string>(releasedRowIds);
  for (const trId of Object.keys(reportScopeByTrId)) {
    if (visibleRowIds.has(trId)) viewedCountIds.add(trId);
  }
  const viewedCountByTrId = new Map<string, number>(
    await Promise.all(
      Array.from(viewedCountIds).map(
        async (trId) => [trId, await countResultViews(trId)] as const,
      ),
    ),
  );
  const viewedCountRecord = Object.fromEntries(viewedCountByTrId);

  // "Edited <date/time> — <reason>" notes (0172 §6.1). result_amendments is
  // readable only through the SIGNED-IN client — RLS (staff_can_read_
  // finished_result) restricts it to pathologist/admin and an in-section
  // medtech/xray_technician; reception's read comes back empty, which is
  // correct (the note simply doesn't show). One batched query for every
  // amended result on this visit, then a pure fold picks the latest reason
  // per result and assigns the full note to the first member in page order.
  const amendedResultIds = Array.from(
    new Set(
      Array.from(amendmentCountByTrId.entries())
        .filter(([, count]) => count > 0)
        .map(([trId]) => resultIdByTrId.get(trId))
        .filter((v): v is string => !!v),
    ),
  );
  const reasonByResultId = new Map<string, string>();
  if (amendedResultIds.length > 0) {
    const { data: amends } = await supabase
      .from("result_amendments")
      .select("result_id, reason, amendment_seq")
      .in("result_id", amendedResultIds)
      .order("amendment_seq", { ascending: false });
    for (const am of amends ?? []) {
      if (!reasonByResultId.has(am.result_id)) {
        reasonByResultId.set(am.result_id, am.reason);
      }
    }
  }
  const editNoteRows: EditNoteTestRow[] = allRows.map((r) => {
    const svc = Array.isArray(r.services) ? r.services[0] : r.services;
    return {
      id: r.id,
      name: svc?.name ?? "",
      resultId: resultIdByTrId.get(r.id) ?? null,
      amendedAt: amendedAtByTrId.get(r.id) ?? null,
      amendmentCount: amendmentCountByTrId.get(r.id) ?? 0,
    };
  });
  const editNoteByTrId = foldEditNotes(editNoteRows, reasonByResultId);

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
              // Charges, payments and balance with no PIN — for reimbursement
              // claims, consult-only visits (no receipt) and the file copy.
              <Link
                href={`/staff/visits/${visit.id}/statement`}
                className="rounded-md border border-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-navy)] hover:text-white"
              >
                Statement
              </Link>
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
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-heading text-xl font-extrabold text-[color:var(--color-brand-navy)]">
            Tests
          </h2>
          {!visitDeleted && printAllCount >= 2 ? (
            <PrintResultButton
              src={`/staff/visits/${visit.id}/results-pdf`}
              label={`Print all released results (${printAllCount} reports)`}
            />
          ) : null}
        </div>

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
                          // Same reasoning (0172, P0067): a component sitting
                          // on a finished combined report aborts the whole
                          // header delete at depth 2.
                          has_shared_report:
                            sharedReportIds.has(h.id) ||
                            components.some((c) => sharedReportIds.has(c.id)),
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
                              const componentEditNote = editNoteByTrId.get(c.id) ?? null;
                              const componentReportScope = reportScopeByTrId[c.id] ?? null;
                              const componentViewedCount = componentReportScope
                                ? componentReportScope.memberIds.reduce(
                                    (sum, id) => sum + (viewedCountByTrId.get(id) ?? 0),
                                    0,
                                  )
                                : viewedCountByTrId.get(c.id) ?? 0;
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
                                      hasPdf={pdfStates.has(c.id)}
                                      printed={printedFor(c.id)}
                                      canViewPdf={canViewResultPdf(session.role, {
                                        section: rowSection(c),
                                        status: c.status,
                                        kind: csvc.kind,
                                        reportReleased:
                                          pdfStates.get(c.id)?.reportReleased ?? false,
                                      })}
                                      kind={csvc.kind}
                                      viewedCount={componentViewedCount}
                                      editNote={componentEditNote}
                                      reportScope={componentReportScope}
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
                const editNote = editNoteByTrId.get(t.id) ?? null;
                const reportScope = reportScopeByTrId[t.id] ?? null;
                const viewedCountForRow = reportScope
                  ? reportScope.memberIds.reduce(
                      (sum, id) => sum + (viewedCountByTrId.get(id) ?? 0),
                      0,
                    )
                  : viewedCountByTrId.get(t.id) ?? 0;
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
                        hasPdf={pdfStates.has(t.id)}
                        printed={printedFor(t.id)}
                        canViewPdf={canViewResultPdf(session.role, {
                          section: rowSection(t),
                          status: t.status,
                          kind: svc.kind,
                          reportReleased: pdfStates.get(t.id)?.reportReleased ?? false,
                        })}
                        kind={svc.kind}
                        viewedCount={viewedCountForRow}
                        editNote={editNote}
                        reportScope={reportScope}
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
                        has_shared_report: sharedReportIds.has(t.id),
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
          reportScopeByTrId={reportScopeByTrId}
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
                    <PaymentArrivalNote p={p} links={paymentLinks} />
                  </td>
                  <td className="px-4 py-3">
                    {methodLabel(p.method)}
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
                      <div className="flex items-center justify-end gap-4">
                        {/* Edit is offered only where correct_payment (0161)
                            would accept it — gift-code, HMO and imported
                            payments can still be deleted and re-recorded. */}
                        {paymentEditability(p).editable ? (
                          <MovePaymentDialog
                            paymentId={p.id}
                            amount={Number(p.amount_php)}
                            methodLabel={methodLabel(p.method)}
                            currentVisitNumber={visit.visit_number}
                            patientName={`${patient.last_name}, ${patient.first_name}`}
                            patientDrmId={patient.drm_id}
                            otherVisits={otherVisits}
                          />
                        ) : null}
                        {paymentEditability(p).editable ? (
                          <EditPaymentDialog
                            paymentId={p.id}
                            amount={Number(p.amount_php)}
                            method={p.method}
                            methodLabel={methodLabel(p.method)}
                            referenceNumber={p.reference_number}
                            notes={p.notes}
                            receivedLabel={manilaDateTime(p.received_at)}
                            visitTotal={Number(visit.total_php)}
                            visitPaid={Number(visit.paid_php)}
                          />
                        ) : null}
                        <VoidPaymentDialog
                          paymentId={p.id}
                          amountLabel={formatPhp(p.amount_php)}
                          methodLabel={methodLabel(p.method)}
                          isGiftCode={p.method === "gift_code"}
                        />
                      </div>
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
              Deleted, edited &amp; moved payments ({voidedPayments.length})
            </summary>
            <ul className="mt-2 space-y-2 text-xs">
              {voidedPayments.map((p) => (
                <PaymentChangeEntry key={p.id} p={p} links={paymentLinks} />
              ))}
            </ul>
            {isAdmin ? (
              <Link
                href="/staff/admin/reports/payment-changes"
                className="mt-2 inline-block text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
              >
                All payment changes →
              </Link>
            ) : null}
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
  // Staff prints of this line's file (result.printed_staff), for the
  // "Printed …" note.
  printed?: PrintSummary;
  // May this role open the result PDF (canViewResultPdf)? True wherever
  // canAct is, and ALSO for reception on a released lab line — the one door
  // into a result reception has, so the counter can print the patient's copy.
  canViewPdf: boolean;
  kind: string;
  // Patient viewed/downloaded count for a released row — drives the undo
  // dialog's "already viewed" warning. Already aggregated across a combined
  // report's members when `reportScope` is set (0172 §5/§9 R6).
  viewedCount: number;
  // "Edited <date/time> — <reason>" (0172 §6.1), or null when unamended or
  // when RLS returned no reason (reception). Shown on released rows (under
  // View PDF) and on ready_for_release rows.
  editNote?: string | null;
  // Present when this row shares a finished result with other tests — undo
  // reverts the whole report, not just this row (display only).
  reportScope?: { memberIds: string[]; label: string } | null;
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
  printed,
  canViewPdf,
  kind,
  viewedCount,
  editNote = null,
  reportScope = null,
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
  // behind it. Render a read-only status hint — reusing the same words this
  // column already shows for each status — with none of MarkDoneButton,
  // ReleaseButton, UndoReleaseDialog or the "Open in queue →" bench link.
  //
  // The one exception (owner decision 2026-09-24): once a lab line is
  // RELEASED, reception may print it for the patient, so a released line with
  // a file gets "Print result" and "View PDF →". canViewPdf is false for every
  // other status, so nothing on the bench is reachable from here.
  if (!canAct) {
    if (status === "released" && canViewPdf && hasPdf) {
      return (
        <ReleasedPdfActions
          testRequestId={testRequestId}
          sizeCls={sizeCls}
          size={size}
          printed={printed}
        />
      );
    }
    // Released, with a file, yet not printable: this line shares a
    // consolidated PDF with a test that is not released (or was withdrawn),
    // and printing it would hand over that test's values too.
    if (status === "released" && hasPdf) {
      return (
        <div className="flex flex-col items-end gap-0.5">
          <span className={`${sizeCls} font-semibold text-emerald-700`}>
            Released ✓
          </span>
          <span className={`${sizeCls} max-w-48 text-right text-[color:var(--color-brand-text-soft)]`}>
            Rest of this report isn&apos;t released yet — print once the lab releases it
          </span>
        </div>
      );
    }
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
      <div className="flex flex-col items-end gap-0.5">
        <ReleaseButton
          testRequestId={testRequestId}
          visitId={visitId}
          moneySettled={moneySettled}
          preferredMedium={preferredMedium}
          consentOnFile={consentOnFile}
          gateRequired={gateRequired}
          size={size}
        />
        {editNote ? (
          <span className={`${sizeCls} max-w-[16rem] text-right text-violet-800`}>
            {editNote}
          </span>
        ) : null}
      </div>
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
        {hasPdf ? (
          <ReleasedPdfActions
            testRequestId={testRequestId}
            sizeCls={sizeCls}
            size={size}
            printed={printed}
          />
        ) : (
          <span className={`${sizeCls} font-semibold text-emerald-700`}>
            Released ✓
          </span>
        )}
        {editNote ? (
          <span className={`${sizeCls} max-w-[16rem] text-right text-violet-800`}>
            {editNote}
          </span>
        ) : null}
        {/* Headers never reach TestAction (only components + standalones
            render it), so every released row here may offer Undo — the 0110
            cascade flips the header when its last component is undone. */}
        <UndoReleaseDialog
          testRequestId={testRequestId}
          visitId={visitId}
          viewedCount={viewedCount}
          reportScope={reportScope}
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

// A released line with a file on record: the status word, then the two ways to
// hand it over — Print (the counter's paper copy, audited as a print; it
// opens in a tab to print from the viewer) and View PDF (on screen only) —
// then who last printed it. Shared by the lab's released cell and
// reception's read-only one.
function ReleasedPdfActions({
  testRequestId,
  sizeCls,
  size,
  printed,
}: {
  testRequestId: string;
  sizeCls: string;
  size: "default" | "compact";
  printed: PrintSummary | undefined;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      <span className={`${sizeCls} font-semibold text-emerald-700`}>
        Released ✓
      </span>
      <PrintResultButton testRequestId={testRequestId} size={size} />
      <a
        href={`/staff/results/${testRequestId}/pdf`}
        target="_blank"
        rel="noopener"
        className={`${sizeCls} font-bold text-[color:var(--color-brand-cyan)] hover:underline`}
      >
        View PDF →
      </a>
      <PrintedNote summary={printed} size={size} />
    </div>
  );
}
