import { withCronMonitor } from "@/lib/ops/cron-monitor";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report-error";
import { audit } from "@/lib/audit/log";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { todayManilaISODate } from "@/lib/dates/manila";
import { REMIND_UNTIMED_AFTER_DAYS, unactedBookings } from "@/lib/appointments/stale";
import { buildStaleBookingsAlertEmail } from "@/lib/appointments/stale-bookings-alert";
import { sendEmail } from "@/lib/notifications/email";
import { resolveStaffAlertRecipients } from "@/lib/notifications/staff-alert-recipients";

export const dynamic = "force-dynamic";

type OpenRow = {
  id: string;
  booking_group_id: string | null;
  status: string;
  scheduled_at: string | null;
  created_at: string;
  walk_in_name: string | null;
  patients: { first_name: string; deleted_at: string | null } | { first_name: string; deleted_at: string | null }[] | null;
};

// A deleted record's name stays out of staff email; a merged one is the same
// person, so their first name is still fine to show.
function firstNameOf(row: OpenRow): string | null {
  const p = Array.isArray(row.patients) ? row.patients[0] : row.patients;
  if (p) return p.deleted_at ? null : p.first_name;
  return row.walk_in_name;
}

// Vercel Cron sends GET by default. Every morning (00:30 UTC = 08:30 Manila)
// emails the "Bookings not acted on" alert (0186): bookings with no set time
// still confirmed REMIND_UNTIMED_AFTER_DAYS+ days after they were made. Sent
// only when there is at least one. Read-only — nothing is ever closed here;
// reception clears the list by hand from the Appointments page.
export async function GET(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return withCronMonitor("stale-bookings", async (markFailed) => {
    const admin = createAdminClient();
    try {
      // The same set and order as the Appointments page's "Bookings with no
      // set time" section, so the email's bookings are the page's bookings.
      const { rows } = await fetchAllRows<OpenRow>(
        (from, to) =>
          admin
            .from("appointments")
            .select(
              "id, booking_group_id, status, scheduled_at, created_at, walk_in_name, patients ( first_name, deleted_at )",
            )
            .is("scheduled_at", null)
            .in("status", ["confirmed", "arrived"])
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to)
            .returns<OpenRow[]>(),
        REPORT_EXPORT_MAX_ROWS,
      );
      const bookings = unactedBookings(rows, todayManilaISODate());
      const likely = bookings.filter((b) => b.likelyNoShow).length;

      if (bookings.length === 0) {
        await audit({
          actor_id: null,
          actor_type: "system",
          action: "system.stale_bookings.completed",
          metadata: { bookings: 0, emailed: 0, remind_after_days: REMIND_UNTIMED_AFTER_DAYS },
        });
        return Response.json({ bookings: 0, emailed: 0 });
      }

      // Who gets it is managed in Admin Tools › Email Alerts (0186): by
      // default active reception + admin, plus any extra addresses; an admin
      // can switch people on/off or turn the reminder off entirely.
      const alert = await resolveStaffAlertRecipients("stale_bookings", admin);
      const recipients = alert.emails;

      const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://drmed.ph";
      const content = buildStaleBookingsAlertEmail({
        bookings: bookings.map((b) => ({
          firstName: firstNameOf(b.rows[0]),
          ageDays: b.ageDays,
          likelyNoShow: b.likelyNoShow,
        })),
        appointmentsUrl: `${base}/staff/appointments#no-set-time`,
      });

      let emailed = 0;
      for (const to of recipients) {
        const r = await sendEmail({ to, subject: content.subject, text: content.text, html: content.html });
        if (r.ok) emailed += 1;
        else markFailed();
      }
      await audit({
        actor_id: null,
        actor_type: "system",
        action: "system.stale_bookings.sent",
        metadata: {
          bookings: bookings.length,
          likely_no_shows: likely,
          recipients: recipients.length,
          emailed,
          ...(alert.enabled ? {} : { skipped: "turned off in Email Alerts" }),
        },
      });
      await audit({
        actor_id: null,
        actor_type: "system",
        action: "system.stale_bookings.completed",
        metadata: { bookings: bookings.length, recipients: recipients.length, emailed },
      });
      return Response.json({ bookings: bookings.length, recipients: recipients.length, emailed });
    } catch (error) {
      await reportError({ scope: "cron/stale-bookings", error });
      return Response.json({ error: "failed" }, { status: 500 });
    }
  });
}
