import { requireAdminStaff } from "@/lib/auth/require-admin";
import { ROUTE_NAME, SECTION_NAME } from "@/lib/staff/route-names";
import { PageHeader } from "@/components/staff/page-header";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { isISODate, manilaRangeUtc, todayManilaISODate } from "@/lib/dates/manila";
import { buildPeriodPresets } from "@/lib/reports/period-presets";
import { StatCard } from "../../_dashboards/_components/stat-card";
import { PeriodChips } from "./_components/period-chips";
import { ProportionTable } from "./_components/proportion-table";
import {
  summarizeBookings,
  summarizeMessages,
  type AppointmentSourceRow,
  type ContactMessageSourceRow,
} from "@/lib/marketing/booking-sources";

export const metadata = { title: ROUTE_NAME["/staff/marketing/sources"] };
export const dynamic = "force-dynamic";

const PATHNAME = "/staff/marketing/sources";

interface SearchProps {
  searchParams: Promise<{ from?: string; to?: string }>;
}

export default async function BookingSourcesReportPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const todayISO = todayManilaISODate();
  const thisMonth = buildPeriodPresets(todayISO).find((p) => p.key === "this-month")!;
  const from = isISODate(sp.from) ? sp.from : thisMonth.start;
  const to = isISODate(sp.to) ? sp.to : thisMonth.end;

  const { fromIso, toIso } = manilaRangeUtc(from, to);
  const supabase = await createClient();

  const [
    { rows: apptRows, truncated: apptTruncated },
    { rows: msgRows, truncated: msgTruncated },
  ] = await Promise.all([
    fetchAllRows<AppointmentSourceRow>(
      (rFrom, rTo) => {
        let q = supabase
          .from("appointments")
          .select("id, booking_group_id, source, attribution, status, created_at");
        if (fromIso) q = q.gte("created_at", fromIso);
        if (toIso) q = q.lt("created_at", toIso);
        return q
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(rFrom, rTo)
          .returns<AppointmentSourceRow[]>();
      },
      REPORT_EXPORT_MAX_ROWS,
    ),
    fetchAllRows<ContactMessageSourceRow>(
      (rFrom, rTo) => {
        let q = supabase.from("contact_messages").select("id, kind, status, attribution, created_at");
        if (fromIso) q = q.gte("created_at", fromIso);
        if (toIso) q = q.lt("created_at", toIso);
        return q
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(rFrom, rTo)
          .returns<ContactMessageSourceRow[]>();
      },
      REPORT_EXPORT_MAX_ROWS,
    ),
  ]);

  const bookings = summarizeBookings(apptRows);
  const messages = summarizeMessages(msgRows);

  const bookedRatePct = messages.bookedRate == null ? "—" : `${Math.round(messages.bookedRate * 100)}%`;

  return (
    <div>
      <PageHeader
        eyebrow={SECTION_NAME["/staff/marketing"]}
        title={ROUTE_NAME["/staff/marketing/sources"]}
        subtitle="Where appointments and website messages came from, for a chosen period. Online
          bookings and messages tag themselves automatically; a booking made by phone or in
          person is only countable here from the day reception started picking “How did they
          reach us?” in the New appointment form."
      />

      <PeriodChips pathname={PATHNAME} from={from} to={to} todayISO={todayISO} />

      {apptTruncated || msgTruncated ? (
        <p
          role="status"
          className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          Showing the first {REPORT_EXPORT_MAX_ROWS.toLocaleString("en-PH")} rows of one or more
          sets for this period — there are more than that, so the figures below may undercount.
          Pick a shorter period.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Bookings"
          value={bookings.activeBookingGroups.toLocaleString("en-PH")}
          hint={`${bookings.cancelledOrNoShowBookingGroups.toLocaleString("en-PH")} cancelled or no-show, not counted here`}
        />
        <StatCard
          label="Website messages"
          value={messages.total.toLocaleString("en-PH")}
          hint={`${messages.bookedCount.toLocaleString("en-PH")} led to a booking`}
        />
        <StatCard
          label="Message → booking rate"
          value={bookedRatePct}
          hint="Website messages whose status is Booked, over all messages in the period."
        />
      </div>

      <ProportionTable
        title="Bookings by source"
        columnLabel="Source"
        rows={bookings.bySource.map((s) => ({ label: s.label, count: s.count, cancelled: s.cancelled }))}
        showCancelled
        note="Online bookings and patient-portal bookings tag themselves. A booking made by
          reception only has a source once they started answering “How did they reach us?” in
          the New appointment form — earlier staff bookings show as Not recorded. “Cancelled /
          no-show” counts bookings from that source that were later cancelled or marked no-show
          — they're counted separately and are not part of Count or Share."
      />

      <ProportionTable
        title="Bookings by ad campaign"
        columnLabel="Campaign"
        rows={bookings.byCampaign.map((c) => ({ label: c.label, count: c.count, cancelled: c.cancelled }))}
        showCancelled
        note="Online bookings carry the ad tag from the link the patient clicked. A booking made
          by staff only has one when it came from a website message that itself carried a tag —
          every other staff booking shows as no ad tag. “Cancelled / no-show” counts bookings
          under that campaign that were later cancelled or marked no-show — they're counted
          separately and are not part of Count or Share."
      />

      <ProportionTable
        title="Website messages by type"
        columnLabel="Type"
        rows={messages.byKind.map((k) => ({ label: k.label, count: k.count }))}
        note="Corporate / HMO lead messages come from the contact form's Corporate / HMO subject; every other subject is General."
      />

      <ProportionTable
        title="Website messages by status"
        columnLabel="Status"
        rows={messages.byStatus.map((s) => ({ label: s.label, count: s.count }))}
        note="A message reaches Booked only when reception books an appointment from it — see the Website Messages inbox."
      />

      <ProportionTable
        title="Website messages by ad campaign"
        columnLabel="Campaign"
        rows={messages.byCampaign.map((c) => ({ label: c.label, count: c.count }))}
        note="The ad tag from the link the sender clicked before filling in the contact form, if any."
      />
    </div>
  );
}
