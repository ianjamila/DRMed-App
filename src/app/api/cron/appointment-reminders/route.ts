import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report-error";
import { audit } from "@/lib/audit/log";
import { manilaDayWindowUtc } from "@/lib/dates/manila";
import { notifyAppointmentReminder } from "@/lib/notifications/notify-appointment-reminder";

export const dynamic = "force-dynamic";

// Vercel Cron sends GET by default. Reminds patients the evening before a
// confirmed appointment (cron scheduled at 10:00 UTC = 6 PM Manila).
export async function GET(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { startIso, endIso } = manilaDayWindowUtc(1); // tomorrow, Manila
  const admin = createAdminClient();

  const { data: due, error } = await admin
    .from("appointments")
    .select("id, patient_id")
    .eq("status", "confirmed")
    .gte("scheduled_at", startIso)
    .lt("scheduled_at", endIso)
    .is("reminder_sent_at", null);

  if (error) {
    await reportError({ scope: "cron/appointment-reminders:query", error });
    return Response.json({ error: "query failed" }, { status: 500 });
  }

  let emailed = 0;
  let skippedNoEmail = 0;
  const failures: Array<{ appointment_id: string; error: string }> = [];

  for (const a of due ?? []) {
    try {
      const r = await notifyAppointmentReminder({
        appointmentId: a.id,
        patientId: a.patient_id,
      });
      if (r.emailed) emailed += 1;
      else skippedNoEmail += 1;

      // Stamp so this appointment is processed once (sent or skipped-no-email).
      await admin
        .from("appointments")
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq("id", a.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reportError({
        scope: "cron/appointment-reminders:appointment",
        error: err,
        metadata: { appointment_id: a.id },
      });
      await audit({
        actor_id: null,
        actor_type: "system",
        patient_id: a.patient_id,
        action: "appointment.reminder.failed",
        resource_type: "appointment",
        resource_id: a.id,
        metadata: { error: msg },
      });
      // Leave reminder_sent_at NULL so a re-run can retry.
      failures.push({ appointment_id: a.id, error: msg });
    }
  }

  return Response.json({
    window: { startIso, endIso },
    processed: due?.length ?? 0,
    emailed,
    skipped_no_email: skippedNoEmail,
    failures,
  });
}
