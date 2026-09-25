import { ROUTE_NAME } from "@/lib/staff/route-names";
import { cache, type ReactNode } from "react";
import Link from "next/link";
import { detailMetadata } from "@/lib/staff/detail-metadata";
import { notFound, redirect } from "next/navigation";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sectionsForRole } from "@/lib/auth/role-sections";
import { isSectionAllowed } from "@/lib/auth/section-access";
import { deriveEnabledParamIds } from "@/lib/results/enabled-params";
import { partitionConsolidatedMembers } from "@/lib/results/consolidated-reports";
import { labQueueGate } from "@/lib/visits/lab-gate";
import { audit } from "@/lib/audit/log";
import { hasRecentAudit, ipAndAgent } from "@/lib/server/action-helpers";
import { ConsolidatedForm } from "./consolidated-form";
import { ReportCards, type ReportCardData } from "./report-cards";
import { ReportEditForm } from "./report-edit-form";
import type { ValueCells } from "./consolidated-values-table";
import { normalisePatientSex } from "@/lib/results/types";
import { claimRemarks } from "@/lib/queue/claim-remarks";
import { fetchClaimEvents } from "@/lib/queue/fetch-claim-events";
import { ClaimHistory } from "@/components/staff/claim-remarks-list";
import { QueueUnclaimButton } from "../../../queue-unclaim-button";

type One<T> = T | T[] | null;
const one = <T,>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

interface MemberRow {
  id: string;
  status: string;
  assigned_to: string | null;
  released_at: string | null;
  services: One<{ id: string; code: string; name: string; section: string | null; report_group_id: string | null }>;
  visits: One<ConsolidatedFormVisit & { payment_status: string; hmo_provider_id: string | null }>;
  result_test_requests: One<{
    result_id: string;
    results: One<{
      id: string;
      storage_path: string | null;
      finalised_at: string | null;
      finalised_by_staff_id: string | null;
      amended_at: string | null;
      amendment_count: number;
    }>;
  }>;
}

const loadConsolidatedDetail = cache(async (visitId: string, groupId: string) => {
  const session = await requireActiveStaff();

  const supabase = await createClient();

  const { data: group } = await supabase
    .from("report_groups")
    .select("id, code, name")
    .eq("id", groupId)
    .single();
  if (!group) redirect("/staff/queue");

  // Every member of this visit's report group — work still on the bench AND
  // tests whose report is already finalised (awaiting sign-off, awaiting
  // payment, or released). This page used to load only the bench statuses and
  // bounce everything else to /staff/queue, which left a finished chemistry
  // report with no page at all: the queue's Open, Critical Alerts, the visit
  // page and the notification bell all funnel through here.
  //
  // Package headers are excluded explicitly. The old status filter excluded
  // them by accident (a header auto-promotes straight to ready_for_release);
  // widening the statuses would let a LIPID_PROFILE_PACKAGE header in, whose
  // section is `package` — the section gate below would then deny the whole
  // page to a medtech.
  const { data } = await supabase
    .from("test_requests")
    .select(
      `
      id, status, assigned_to, released_at,
      services!inner(id, code, name, section, report_group_id),
      visits!inner(id, visit_number, patient_id, payment_status, hmo_provider_id,
                   patients!inner(drm_id, last_name, first_name, sex, birthdate)),
      result_test_requests(result_id,
        results(id, storage_path, finalised_at, finalised_by_staff_id, amended_at, amendment_count))
    `,
    )
    .eq("visit_id", visitId)
    .eq("services.report_group_id", groupId)
    .eq("is_package_header", false)
    .neq("status", "cancelled")
    // Soft-deleted lines / visits (0125) are out of both the form and the reports.
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    .order("requested_at", { ascending: true })
    .order("id", { ascending: true })
    .returns<MemberRow[]>();
  const rows = data ?? [];

  const partition = partitionConsolidatedMembers(
    rows.map((r) => {
      const link = one(r.result_test_requests);
      return {
        id: r.id,
        status: r.status,
        resultId: link?.result_id ?? null,
        hasPdf: Boolean(one(link?.results ?? null)?.storage_path),
      };
    }),
  );
  const inReport = new Set(partition.reports.flatMap((r) => r.memberIds));
  const encodeSet = new Set(partition.encodeIds);
  const shown = rows.filter((r) => inReport.has(r.id) || encodeSet.has(r.id));
  if (shown.length === 0) redirect("/staff/queue");

  // N1 (go-live): section gate. This is the sibling of the single-test
  // detail page's gate (queue/[id]/page.tsx) — that fix gated
  // /staff/queue/<id> but missed this route, which shows the exact same
  // patient-name / service-code / parameter-name detail for every test in
  // the group. RLS on test_requests permits every lab role (and reception)
  // to read these rows (0023), so this app-level filter is the only guard.
  // sectionsForRole(role) === [] is a DENY, never "no filter" — reception's
  // case. null = unrestricted (admin/pathologist), same as every other
  // section-gated surface.
  //
  // The gate covers every row the page shows — the form's AND each finished
  // report's members — since a report card lists its tests and links its
  // PDF. Every row belongs to one report group, which in practice means one
  // lab section, so deny the whole page rather than filtering rows out of a
  // shared report.
  const allowedSections = sectionsForRole(session.role);
  const sectionOk = shown.every((r) =>
    isSectionAllowed(allowedSections, one(r.services)?.section ?? null),
  );
  if (!sectionOk) notFound();

  const visit = one(shown[0].visits);
  if (!visit) notFound();

  return { session, supabase, group, rows, partition, visit };
});

export async function generateMetadata({ params }: { params: Promise<{ visitId: string; groupId: string }> }) {
  await requireActiveStaff();
  const { visitId, groupId } = await params;
  return detailMetadata(ROUTE_NAME["/staff/queue/consolidated/[visitId]/[groupId]"], async () => {
    const { group, visit } = await loadConsolidatedDetail(visitId, groupId);
    return `${group.name} · #${visit.visit_number}`;
  });
}

export default async function ConsolidatedQueuePage({
  params,
  searchParams,
}: {
  params: Promise<{ visitId: string; groupId: string }>;
  searchParams: Promise<{ edit?: string | string[] }>;
}) {
  const { visitId, groupId } = await params;
  const editParam = (await searchParams).edit;
  const editResultId = typeof editParam === "string" ? editParam : null;
  const { session, supabase, group, rows, partition, visit } = await loadConsolidatedDetail(
    visitId,
    groupId,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));

  // ---- Finished reports -------------------------------------------------
  const resultIds = partition.reports.map((r) => r.resultId);
  const reportResults = new Map(
    partition.reports.map((rep) => {
      const res = one(one(byId.get(rep.memberIds[0])!.result_test_requests)!.results)!;
      return [rep.resultId, res] as const;
    }),
  );

  // Every amendment per report (newest first): the "Edited <when> — <reason>"
  // line uses the latest, the edit-history panel lists them all. Read through
  // the signed-in client — 0172 limits it to staff who may read the values.
  type Amendment = { reason: string; amended_at: string; amended_by: string; amendment_seq: number };
  const amendmentsByResult = new Map<string, Amendment[]>();
  if (resultIds.some((id) => (reportResults.get(id)?.amendment_count ?? 0) > 0)) {
    const { data: amends } = await supabase
      .from("result_amendments")
      .select("result_id, reason, amended_at, amended_by, amendment_seq")
      .in("result_id", resultIds)
      .order("amendment_seq", { ascending: false });
    for (const a of amends ?? []) {
      const list = amendmentsByResult.get(a.result_id) ?? [];
      list.push(a);
      amendmentsByResult.set(a.result_id, list);
    }
  }
  const latestAmendment = new Map(
    [...amendmentsByResult].map(([id, list]) => [id, list[0]] as const),
  );

  // Who may edit each report: the database's own rule (every linked test in
  // the caller's sections, every live one finished), asked as the signed-in
  // user — the same call amendConsolidatedReport makes, so the button never
  // offers what the action refuses [R3].
  const canEdit = new Map<string, boolean>();
  for (const id of resultIds) {
    const { data } = await supabase.rpc("staff_can_read_finished_result", { p_result_id: id });
    canEdit.set(id, data === true);
  }

  const staffIds = new Set<string>();
  for (const res of reportResults.values()) {
    if (res.finalised_by_staff_id) staffIds.add(res.finalised_by_staff_id);
  }
  for (const list of amendmentsByResult.values()) for (const a of list) staffIds.add(a.amended_by);
  const staffName = new Map<string, string>();
  if (staffIds.size > 0) {
    const { data: profs } = await supabase
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", Array.from(staffIds));
    for (const p of profs ?? []) staffName.set(p.id, p.full_name);
  }

  const gate = labQueueGate(visit);
  const reports: ReportCardData[] = partition.reports.map((rep) => {
    const res = reportResults.get(rep.resultId)!;
    const members = rep.memberIds.map((id) => {
      const r = byId.get(id)!;
      const svc = one(r.services);
      return {
        id,
        code: svc?.code ?? "",
        name: svc?.name ?? "",
        status: r.status,
        releasedAt: r.released_at,
      };
    });
    const amendment = latestAmendment.get(rep.resultId);
    return {
      resultId: rep.resultId,
      pdfTestRequestId: rep.memberIds[0],
      members,
      finalisedAt: res.finalised_at,
      finalisedBy: res.finalised_by_staff_id
        ? (staffName.get(res.finalised_by_staff_id) ?? null)
        : null,
      amendmentCount: res.amendment_count,
      lastAmendment: amendment
        ? {
            at: amendment.amended_at,
            reason: amendment.reason,
            by: staffName.get(amendment.amended_by) ?? null,
          }
        : null,
      history: (amendmentsByResult.get(rep.resultId) ?? []).map((a) => ({
        seq: a.amendment_seq,
        at: a.amended_at,
        reason: a.reason,
        by: staffName.get(a.amended_by) ?? null,
      })),
      editHref: canEdit.get(rep.resultId)
        ? `/staff/queue/consolidated/${visitId}/${groupId}?edit=${rep.resultId}#result-${rep.resultId}`
        : null,
    };
  });

  // ---- Edit form for one finished report (?edit=<resultId>) -------------
  let editForm: { resultId: string; node: ReactNode } | null = null;
  const editing = editResultId ? reports.find((r) => r.resultId === editResultId) : undefined;
  if (editing && canEdit.get(editing.resultId)) {
    const res = reportResults.get(editing.resultId)!;
    const { data: template, error: templateErr } = await supabase
      .from("result_templates")
      .select("id, layout, header_notes, footer_notes, result_template_params(*)")
      .eq("report_group_id", groupId)
      .eq("is_active", true)
      .maybeSingle();
    const tplParams = ((template as unknown as ConsolidatedFormTemplate | null)?.result_template_params ?? []);
    // Values through the signed-in client: the 0172 read policy is the same
    // rule as canEdit above.
    const { data: valueRows, error: valuesErr } = await supabase
      .from("result_values")
      .select("parameter_id, numeric_value_si, numeric_value_conv")
      .eq("result_id", editing.resultId);
    const liveServiceIds = editing.members.map((m) => one(byId.get(m.id)!.services)?.id ?? "");
    const { data: mapRows, error: mapErr } =
      tplParams.length > 0
        ? await supabase
            .from("report_group_service_params")
            .select("service_id, parameter_id")
            .in("parameter_id", tplParams.map((p) => p.id))
            .in("service_id", liveServiceIds)
        : { data: [], error: null };
    // An edit REPLACES the whole value set, so a form opened over values that
    // failed to load would save a partial set and erase the rest. Refuse to
    // render it instead.
    const loadFailed = Boolean(templateErr || valuesErr || mapErr);
    // Editable = what the members' services enable, plus anything already
    // holding a value (a mapping changed since finalise must not strand it).
    const stored = new Set((valueRows ?? []).map((v) => v.parameter_id));
    const editable = new Set<string>([...(mapRows ?? []).map((m) => m.parameter_id), ...stored]);
    const sex = normalisePatientSex(visit.patients.sex);
    const params = tplParams
      .filter((p) => !p.gender || p.gender === sex || stored.has(p.id))
      .sort((a, b) => a.sort_order - b.sort_order);
    const initial: ValueCells = {};
    for (const v of valueRows ?? []) {
      initial[v.parameter_id] = {
        si: v.numeric_value_si == null ? "" : String(v.numeric_value_si),
        conv: v.numeric_value_conv == null ? "" : String(v.numeric_value_conv),
      };
    }
    editForm = {
      resultId: editing.resultId,
      node: loadFailed ? (
        <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          This report&apos;s values couldn&apos;t be loaded, so it can&apos;t be edited right now.
          Reload the page to try again.
        </p>
      ) : template ? (
        <ReportEditForm
          key={`${editing.resultId}:${res.amendment_count}`}
          resultId={editing.resultId}
          expectedAmendmentCount={res.amendment_count}
          params={params}
          editableParamIds={[...editable]}
          initial={initial}
          doneHref={`/staff/queue/consolidated/${visitId}/${groupId}#result-${editing.resultId}`}
        />
      ) : (
        <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {group.name} has no active result template, so this report can&apos;t be edited. Ask an
          admin to check Result Templates.
        </p>
      ),
    };
  }

  // Viewing a finished report is a disclosure of patient results, so it is
  // audited like the PDF route (`result.viewed_staff`). One row per result;
  // the same viewer re-rendering within 5 minutes (refresh, back button) is
  // not a new view. Never from generateMetadata — only a real render counts.
  if (resultIds.length > 0) {
    const admin = createAdminClient();
    const { ip, ua } = await ipAndAgent();
    for (const resultId of resultIds) {
      const recent = await hasRecentAudit(
        admin,
        { actor_id: session.user_id, action: "result.report_viewed_staff", resource_id: resultId },
        5,
      );
      if (recent) continue;
      await audit({
        actor_id: session.user_id,
        actor_type: "staff",
        patient_id: visit.patient_id,
        action: "result.report_viewed_staff",
        resource_type: "result",
        resource_id: resultId,
        metadata: {
          visit_id: visit.id,
          report_group_id: group.id,
          test_request_ids: partition.reports.find((r) => r.resultId === resultId)!.memberIds,
        },
        ip_address: ip,
        user_agent: ua,
      });
    }
  }

  // ---- Work still on the bench -----------------------------------------
  const encodeRows = partition.encodeIds.map((id) => byId.get(id)!);
  let form: ReactNode = null;
  if (encodeRows.length > 0) {
    const { data: template } = await supabase
      .from("result_templates")
      .select("id, layout, header_notes, footer_notes, result_template_params(*)")
      .eq("report_group_id", groupId)
      .eq("is_active", true)
      .single();

    if (!template) {
      form = (
        <p
          role="alert"
          className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700"
        >
          {group.name} has no active result template, so the remaining tests can&apos;t be
          encoded. Ask an admin to check Result Templates.
        </p>
      );
    } else {
      // Which params this visit's ordered services enable — from
      // report_group_service_params (0120), not the old hardcoded map.
      const orderedServiceIds = encodeRows.map((r) => one(r.services)?.id ?? "");
      const { data: mapRows } = await supabase
        .from("report_group_service_params")
        .select("service_id, parameter_id")
        .in(
          "parameter_id",
          (template.result_template_params ?? []).map((p: { id: string }) => p.id),
        );
      const enabledParamIds = [...deriveEnabledParamIds(mapRows ?? [], orderedServiceIds)];

      // claimedBy resolution: if the signed-in user is the assigned_to on ANY
      // of the in-scope test_requests, the report is "claimed by me." Otherwise
      // if some other user is assigned to one, "claimed by another." Otherwise
      // null = unassigned and claimable.
      const myStaffId = session.user_id;
      const distinctAssignees = Array.from(
        new Set(encodeRows.map((r) => r.assigned_to).filter((id): id is string => id != null)),
      );
      const claimedBy = distinctAssignees.includes(myStaffId)
        ? myStaffId
        : (distinctAssignees[0] ?? null);

      // Claim history for the tests still on the bench (a group claim/unclaim
      // writes one event per member; claimRemarks folds those into one line),
      // plus Unclaim — the single-test page has "Your claim › Unclaim".
      // Same rule as the queue row: the holder, or an admin; every member still
      // in progress. unclaimFromQueueAction re-proves all of it. Finished
      // reports are not in this set: they are past claiming.
      const testRequestIds = encodeRows.map((r) => r.id);
      const events = await fetchClaimEvents(supabase, testRequestIds);
      const history = claimRemarks(testRequestIds.flatMap((id) => events.get(id) ?? []));
      // A non-admin must hold EVERY member — the same all-or-nothing check
      // performUnclaim makes, so the button never offers what the action refuses.
      const canUnclaim =
        claimedBy !== null &&
        encodeRows.every(
          (r) =>
            r.status === "in_progress" &&
            r.assigned_to !== null &&
            (session.role === "admin" || r.assigned_to === myStaffId),
        );

      // Payment gate (item 10): an unclaimed report on a visit still waiting for
      // payment shows a notice instead of the claim button. claimConsolidated
      // enforces the same rule server-side, so this is UX, not the guard.
      form = (
        <ConsolidatedForm
          claimBlockedHint={gate.ok ? null : gate.hint}
          group={group}
          template={template as unknown as ConsolidatedFormTemplate}
          visit={visit}
          orderedServiceCodes={encodeRows.map((r) => one(r.services)?.code ?? "")}
          testRequestIds={testRequestIds}
          claimPanel={
            <div className="mt-4 flex flex-wrap items-start justify-between gap-4 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
              <ClaimHistory remarks={history} />
              {canUnclaim ? (
                <QueueUnclaimButton testRequestIds={testRequestIds} entryLabel={group.name} />
              ) : null}
            </div>
          }
          enabledParamIds={enabledParamIds}
          claimedBy={claimedBy}
          myStaffId={myStaffId}
          hasFinishedReports={reports.length > 0}
        />
      );
    }
  }

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/queue"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Queue
      </Link>

      <header className="mt-3">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {group.name}
        </h1>
        {/* DRM-ID + visit number deliberately omitted from result entry —
            partner revision 11: the bench identifies the patient by name. */}
        <p className="mt-1 font-semibold text-[color:var(--color-brand-navy)]">
          {visit.patients.last_name}, {visit.patients.first_name}
        </p>
        {encodeRows.length > 0 ? (
          <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-sm text-[color:var(--color-brand-text-soft)]">
            <span>{reports.length > 0 ? "Still to encode:" : "Ordered:"}</span>
            {encodeRows.map((r) => (
              <span key={r.id} className="font-mono text-xs text-[color:var(--color-brand-navy)]">
                {one(r.services)?.code}
              </span>
            ))}
          </div>
        ) : null}
      </header>

      {reports.length > 0 ? (
        <ReportCards
          reports={reports}
          groupName={group.name}
          awaitingPaymentHint={gate.ok ? null : gate.hint}
          editForm={editForm}
        />
      ) : null}

      {form}

      <Link
        href={`/staff/visits/${visit.id}`}
        className="mt-6 inline-block text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        Open visit →
      </Link>
    </div>
  );
}

// Local types for the deep-join shapes that Supabase can't infer automatically.
export interface ConsolidatedFormTemplate {
  id: string;
  layout: string;
  header_notes: string | null;
  footer_notes: string | null;
  result_template_params: Array<{
    id: string;
    sort_order: number;
    parameter_name: string;
    input_type: string;
    unit_si: string | null;
    unit_conv: string | null;
    gender: "F" | "M" | null;
    si_to_conv_factor: number | null;
  }>;
}

export interface ConsolidatedFormVisit {
  id: string;
  patient_id: string;
  visit_number: string;
  patients: {
    drm_id: string;
    last_name: string;
    first_name: string;
    // patients.sex is stored as 'male'/'female' in the DB. Use the typed
    // shape here; the client form normalises via normalisePatientSex().
    sex: string | null;
    birthdate: string | null;
  };
}
