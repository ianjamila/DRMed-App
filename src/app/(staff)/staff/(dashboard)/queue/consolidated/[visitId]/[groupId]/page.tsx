import { redirect } from "next/navigation";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { ConsolidatedForm } from "./consolidated-form";

export const metadata = {
  title: "Chemistry report — staff",
};

export default async function ConsolidatedQueuePage({
  params,
}: {
  params: Promise<{ visitId: string; groupId: string }>;
}) {
  const { visitId, groupId } = await params;
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
      services!inner(id, code, name, report_group_id),
      visits!inner(id, visit_number, patient_id,
                   patients!inner(drm_id, last_name, first_name, sex, birthdate))
    `,
    )
    .eq("visit_id", visitId)
    .eq("services.report_group_id", groupId)
    .in("status", ACTIVE_STATUSES);
  if (!requests || requests.length === 0) redirect("/staff/queue");

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

  return (
    <ConsolidatedForm
      group={group}
      template={template as unknown as ConsolidatedFormTemplate}
      visit={requests[0].visits as unknown as ConsolidatedFormVisit}
      orderedServiceCodes={requests.map((r) => {
        const svc = Array.isArray(r.services) ? r.services[0] : r.services;
        return svc?.code ?? "";
      })}
      testRequestIds={requests.map((r) => r.id)}
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
