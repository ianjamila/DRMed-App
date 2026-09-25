import { withCronMonitor } from "@/lib/ops/cron-monitor";
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
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  return withCronMonitor("appointment-reminders", async (markFailed) => {
    // M1: rolling catch-up — a missed cron run must not permanently drop that
    // day's reminders. Window = [now, end of tomorrow Manila]: still-future
    // appointments whose reminder was never stamped get caught up (possibly
    // same-day), past appointments are never reminded retroactively.
    const { endIso } = manilaDayWindowUtc(1);
    const startIso = new Date().toISOString();
    const admin = createAdminClient();

    const { data: due, error } = await admin
      .from("appointments")
      .select("id, patient_id, patients ( deleted_at, merged_into_id )")
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
    let skippedInactive = 0;
    const failures: Array<{ appointment_id: string; error: string }> = [];

    for (const a of due ?? []) {
      // Not stamped: a restored record still gets its reminder next run. The
      // sender re-checks anyway (fresh read) — this only keeps the batch from
      // doing work it already knows will be skipped.
      const p = Array.isArray(a.patients) ? a.patients[0] : a.patients;
      if (a.patient_id && p && (p.deleted_at || p.merged_into_id)) {
        skippedInactive += 1;
        continue;
      }
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

    // Run heartbeat, including quiet days with no appointments due.
    await audit({
      actor_id: null,
      actor_type: "system",
      action: "appointment.reminders.completed",
      metadata: {
        processed: due?.length ?? 0,
        emailed,
        skipped_no_email: skippedNoEmail,
        skipped_inactive: skippedInactive,
        failures: failures.length,
      },
    });

    if (failures.length > 0) markFailed();
    return Response.json({
      window: { startIso, endIso },
      processed: due?.length ?? 0,
      emailed,
      skipped_no_email: skippedNoEmail,
      skipped_inactive: skippedInactive,
      failures,
    });
  });
}
