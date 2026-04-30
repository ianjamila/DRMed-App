import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { SITE } from "@/lib/marketing/site";
import { sendEmail } from "./email";
import { sendSms } from "./sms";

interface Input {
  testRequestId: string;
  visitId: string;
}

// Fired by reception's release action. Pulls the patient + test name, sends
// SMS via Semaphore and email via Resend in parallel, audit-logs each
// outcome. Failures never throw — release is the source of truth.
export async function notifyResultReleased({
  testRequestId,
  visitId,
}: Input): Promise<void> {
  const admin = createAdminClient();

  const { data: row } = await admin
    .from("test_requests")
    .select(
      `
        id, visit_id,
        services!inner ( name ),
        visits!inner (
          id,
          patients!inner ( id, drm_id, first_name, phone, email )
        )
      `,
    )
    .eq("id", testRequestId)
    .maybeSingle();

  if (!row) return;
  const visit = Array.isArray(row.visits) ? row.visits[0] : row.visits;
  if (!visit) return;
  const patient = Array.isArray(visit.patients)
    ? visit.patients[0]
    : visit.patients;
  const svc = Array.isArray(row.services) ? row.services[0] : row.services;
  if (!patient || !svc) return;

  const portalUrl = `${SITE.url.replace(/\/$/, "")}/portal`;
  const greeting = patient.first_name || "there";
  const testName = svc.name;

  const smsBody =
    `Hi ${greeting}, your DRMed lab result for ${testName} is ready. ` +
    `Sign in at ${portalUrl} with DRM-ID ${patient.drm_id} and your Secure PIN. — DRMED`;

  const emailSubject = `Your DRMed lab result is ready (${testName})`;
  const emailText = [
    `Hi ${greeting},`,
    "",
    `Your laboratory result for ${testName} has been released.`,
    "",
    `Sign in at ${portalUrl} with:`,
    `  DRM-ID: ${patient.drm_id}`,
    `  Secure PIN: (printed on your receipt)`,
    "",
    "Your PIN is valid for 60 days. Keep it private — anyone with your PIN can view your lab results.",
    "",
    "— DRMed Clinic and Laboratory",
  ].join("\n");

  const [smsResult, emailResult] = await Promise.all([
    patient.phone
      ? sendSms({ to: patient.phone, message: smsBody })
      : Promise.resolve({
          ok: false as const,
          kind: "skipped" as const,
          reason: "patient has no phone on file",
        }),
    patient.email
      ? sendEmail({
          to: patient.email,
          subject: emailSubject,
          text: emailText,
        })
      : Promise.resolve({
          ok: false as const,
          kind: "skipped" as const,
          reason: "patient has no email on file",
        }),
  ]);

  await audit({
    actor_id: null,
    actor_type: "system",
    patient_id: patient.id,
    action: "result.notified",
    resource_type: "test_request",
    resource_id: testRequestId,
    metadata: {
      visit_id: visitId,
      test_name: testName,
      sms: smsResult.ok
        ? { ok: true, id: smsResult.id }
        : smsResult.kind === "skipped"
          ? { ok: false, skipped: true, reason: smsResult.reason }
          : { ok: false, error: smsResult.error },
      email: emailResult.ok
        ? { ok: true, id: emailResult.id }
        : emailResult.kind === "skipped"
          ? { ok: false, skipped: true, reason: emailResult.reason }
          : { ok: false, error: emailResult.error },
    },
  });
}
