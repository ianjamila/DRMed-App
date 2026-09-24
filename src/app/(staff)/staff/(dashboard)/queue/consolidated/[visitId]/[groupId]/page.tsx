import { ROUTE_NAME } from "@/lib/staff/route-names";
import { cache } from "react";
import { detailMetadata } from "@/lib/staff/detail-metadata";
import { notFound, redirect } from "next/navigation";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { sectionsForRole } from "@/lib/auth/role-sections";
import { isSectionAllowed } from "@/lib/auth/section-access";
import { deriveEnabledParamIds } from "@/lib/results/enabled-params";
import { labQueueGate } from "@/lib/visits/lab-gate";
import { ConsolidatedForm } from "./consolidated-form";
import { claimRemarks } from "@/lib/queue/claim-remarks";
import { fetchClaimEvents } from "@/lib/queue/fetch-claim-events";
import { ClaimHistory } from "@/components/staff/claim-remarks-list";
import { QueueUnclaimButton } from "../../../queue-unclaim-button";

const loadConsolidatedDetail = cache(async (visitId: string, groupId: string) => {
  const session = await requireActiveStaff();

  const supabase = await createClient();

  // Load the group + template + params.
  const { data: group } = await supabase
    .from("report_groups")
    .select("id, code, name")
    .eq("id", groupId)
    .single();
  if (!group) redirect("/staff/queue");

  const { data: template } = await supabase
    .from("result_templates")
    .select("id, layout, header_notes, footer_notes, result_template_params(*)")
    .eq("report_group_id", groupId)
    .eq("is_active", true)
    .single();
  if (!template) redirect("/staff/queue");

  // Load this visit's test_requests in this group that are still actionable.
  // Already-released tests stay out of the form — they have their own results
  // PDF from a previous finalise and shouldn't be re-encoded or re-claimed.
  const ACTIVE_STATUSES = ["requested", "in_progress", "result_uploaded"];
  const { data: requests } = await supabase
    .from("test_requests")
    .select(
      `
      id, status, assigned_to,
      services!inner(id, code, name, section, report_group_id),
      visits!inner(id, visit_number, patient_id, payment_status, hmo_provider_id,
                   patients!inner(drm_id, last_name, first_name, sex, birthdate))
    `,
    )
    .eq("visit_id", visitId)
    .eq("services.report_group_id", groupId)
    .in("status", ACTIVE_STATUSES)
    // Soft-deleted lines / visits (0125) are out of the encode form.
    .is("deleted_at", null)
    .is("visits.deleted_at", null);
  if (!requests || requests.length === 0) redirect("/staff/queue");

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
  // Unlike the single-test page, there is no package-header component list
  // to partially filter here: a consolidated report's status filter
  // (ACTIVE_STATUSES above) already excludes package headers entirely —
  // they auto-promote straight to 'ready_for_release' on insert and never
  // carry 'requested'/'in_progress'/'result_uploaded' (see the
  // drmed-result-templates skill), so `requests` can never contain one.
  // Every remaining row belongs to one report group, which in practice
  // means one lab section — deny the whole page unless every row's
  // service section is allowed, rather than trying to filter individual
  // rows out of a single shared report.
  const allowedSections = sectionsForRole(session.role);
  const sectionOk = requests.every((r) => {
    const rsvc = Array.isArray(r.services) ? r.services[0] : r.services;
    return isSectionAllowed(allowedSections, rsvc?.section ?? null);
  });
  if (!sectionOk) notFound();

  return { session, supabase, group, template, requests };
});

export async function generateMetadata({ params }: { params: Promise<{ visitId: string; groupId: string }> }) {
  await requireActiveStaff();
  const { visitId, groupId } = await params;
  return detailMetadata(ROUTE_NAME["/staff/queue/consolidated/[visitId]/[groupId]"], async () => {
    const { group, requests } = await loadConsolidatedDetail(visitId, groupId);
    const visit = Array.isArray(requests[0].visits) ? requests[0].visits[0] : requests[0].visits;
    return visit ? `${group.name} · #${visit.visit_number}` : null;
  });
}

export default async function ConsolidatedQueuePage({
  params,
}: {
  params: Promise<{ visitId: string; groupId: string }>;
}) {
  const { visitId, groupId } = await params;
  const { session, supabase, group, template, requests } = await loadConsolidatedDetail(visitId, groupId);

  // Which params this visit's ordered services enable — from
  // report_group_service_params (0120), not the old hardcoded map. Package
  // headers legitimately have no rows; their components carry the encoding.
  const orderedServiceIds = requests.map((r) => {
    const svc = Array.isArray(r.services) ? r.services[0] : r.services;
    return svc?.id ?? "";
  });
  const { data: mapRows } = await supabase
    .from("report_group_service_params")
    .select("service_id, parameter_id")
    .in(
      "parameter_id",
      (template.result_template_params ?? []).map((p: { id: string }) => p.id),
    );
  const enabledParamIds = [
    ...deriveEnabledParamIds(mapRows ?? [], orderedServiceIds),
  ];

  // claimedBy resolution: if the signed-in user is the assigned_to on ANY
  // of the in-scope test_requests, the report is "claimed by me." Otherwise
  // if some other user is assigned to one, "claimed by another." Otherwise
  // null = unassigned and claimable.
  const myStaffId = session.user_id;
  const distinctAssignees = Array.from(
    new Set(
      requests
        .map((r) => r.assigned_to)
        .filter((id): id is string => id != null),
    ),
  );
  const claimedBy = distinctAssignees.includes(myStaffId)
    ? myStaffId
    : (distinctAssignees[0] ?? null);

  // Payment gate (item 10): an unclaimed report on a visit still waiting for
  // payment shows a notice instead of the claim button. claimConsolidated
  // enforces the same rule server-side, so this is UX, not the guard.
  const firstVisit = Array.isArray(requests[0].visits)
    ? requests[0].visits[0]
    : requests[0].visits;
  const claimGate = labQueueGate(firstVisit);

  // Claim history for the whole panel (a group claim/unclaim writes one event
  // per member; claimRemarks folds those into one line), plus Unclaim — the
  // single-test page has "Your claim › Unclaim", and this page had nothing.
  // Same rule as the queue row: the holder, or an admin; every member still
  // in progress. unclaimFromQueueAction re-proves all of it.
  const testRequestIds = requests.map((r) => r.id);
  const events = await fetchClaimEvents(supabase, testRequestIds);
  const history = claimRemarks(testRequestIds.flatMap((id) => events.get(id) ?? []));
  // A non-admin must hold EVERY member — the same all-or-nothing check
  // performUnclaim makes, so the button never offers what the action refuses.
  const canUnclaim =
    claimedBy !== null &&
    requests.every(
      (r) =>
        r.status === "in_progress" &&
        r.assigned_to !== null &&
        (session.role === "admin" || r.assigned_to === myStaffId),
    );

  return (
    <ConsolidatedForm
      claimBlockedHint={claimGate.ok ? null : claimGate.hint}
      group={group}
      template={template as unknown as ConsolidatedFormTemplate}
      visit={requests[0].visits as unknown as ConsolidatedFormVisit}
      orderedServiceCodes={requests.map((r) => {
        const svc = Array.isArray(r.services) ? r.services[0] : r.services;
        return svc?.code ?? "";
      })}
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
    />
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
