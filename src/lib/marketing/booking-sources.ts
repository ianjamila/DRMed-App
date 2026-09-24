/**
 * Pure aggregation for the Booking Sources report (admin Marketing →
 * Booking Sources, `/staff/marketing/sources`). Given the appointment ROWS
 * and website-message ROWS for a chosen period — already windowed with
 * `manilaRangeUtc` and fetched with `fetchAllRows` by the page — this folds
 * appointment rows into booking GROUPS, classifies each group active vs.
 * cancelled/no-show, and tallies both bookings and website messages by
 * source / ad campaign. No `server-only`, no DB — vitest-tested in
 * `booking-sources.test.ts`.
 */
import { parseAttributionCookie, type Attribution } from "@/lib/analytics/attribution";
import {
  APPOINTMENT_SOURCES,
  APPOINTMENT_SOURCE_LABEL,
  SOURCE_NOT_RECORDED_LABEL,
  attributionCampaignLabel,
  isAppointmentSource,
  type AppointmentSource,
} from "@/lib/appointments/source";
import {
  CONTACT_FORM_LOCATIONS,
  CONTACT_FORM_LOCATION_LABEL,
  FORM_LOCATION_NOT_RECORDED_LABEL,
  isContactFormLocation,
  type ContactFormLocation,
  CONTACT_MESSAGE_KINDS,
  CONTACT_MESSAGE_KIND_LABEL,
  CONTACT_MESSAGE_STATUSES,
  CONTACT_MESSAGE_STATUS_LABEL,
  isContactMessageKind,
  isContactMessageStatus,
  type ContactMessageKind,
  type ContactMessageStatus,
} from "@/lib/contact-messages/labels";

// The label used whenever an attribution has no usable UTM campaign/source/
// medium (organic traffic, or a booking with no attribution at all — every
// staff-made booking not linked to a message).
export const NO_CAMPAIGN_LABEL = "No ad tag (direct / organic)";

// Appointment statuses that mean the booking did not happen. A booking
// GROUP (one or more appointment rows sharing a booking_group_id) counts as
// cancelled/no-show only when EVERY row in it does — a partially-cancelled
// multi-service group still counts as an active booking, same as the
// appointments list's own grouping never splits a group across sections.
const CANCELLED_OR_NO_SHOW = new Set(["cancelled", "no_show"]);

export interface AppointmentSourceRow {
  id: string;
  booking_group_id: string | null;
  source: string | null;
  attribution: unknown;
  status: string;
  created_at: string;
}

export interface ContactMessageSourceRow {
  id: string;
  kind: string;
  form_location: string | null;
  status: string;
  attribution: unknown;
  created_at: string;
}

// Round-trips the stored jsonb through the cookie parser (same as
// contact-messages/booking-link.ts's `toAttribution`) so a malformed value
// degrades to null rather than throwing.
function toAttribution(value: unknown): Attribution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return parseAttributionCookie(JSON.stringify(value));
}

export interface BookingGroup {
  id: string;
  source: AppointmentSource | null;
  attribution: Attribution | null;
  active: boolean;
}

/**
 * Fold appointment ROWS into booking GROUPS. Keyed by `booking_group_id`,
 * falling back to the row's own id for the rare row with none — mirrors
 * `appointments/page.tsx`'s `groupRows`. A group's source/attribution is its
 * FIRST row's: `createAppointmentGroup` / the slot-guarded RPC stamp every
 * row of a group identically, so any row would do.
 */
export function groupBookings(rows: readonly AppointmentSourceRow[]): BookingGroup[] {
  const order: string[] = [];
  const byKey = new Map<
    string,
    { source: AppointmentSource | null; attribution: Attribution | null; statuses: string[] }
  >();
  for (const r of rows) {
    const key = r.booking_group_id ?? r.id;
    let g = byKey.get(key);
    if (!g) {
      g = {
        source: isAppointmentSource(r.source) ? r.source : null,
        attribution: toAttribution(r.attribution),
        statuses: [],
      };
      byKey.set(key, g);
      order.push(key);
    }
    g.statuses.push(r.status);
  }
  return order.map((key) => {
    const g = byKey.get(key)!;
    return {
      id: key,
      source: g.source,
      attribution: g.attribution,
      active: !g.statuses.every((s) => CANCELLED_OR_NO_SHOW.has(s)),
    };
  });
}

export interface SourceCount {
  source: AppointmentSource | null;
  label: string;
  // Active booking groups only — matches the report's headline "Bookings"
  // stat and the proportion bar, which are both active-only.
  count: number;
  // Booking groups from this source that ended cancelled/no-show (every row
  // in the group did) — tallied separately, never folded into `count`.
  cancelled: number;
}

export interface CampaignCount {
  label: string;
  count: number;
}

// Bookings-by-campaign carries the same active/cancelled split as
// SourceCount above; website-messages-by-campaign (summarizeMessages) does
// not — messages don't have a cancelled/no-show state — so it stays on the
// plain CampaignCount shape.
export interface BookingCampaignCount extends CampaignCount {
  cancelled: number;
}

export interface BookingSourceStats {
  totalBookingGroups: number;
  activeBookingGroups: number;
  // Counted separately from the tables below, not split by source — the
  // report's own "cancelled/no-show" figure rather than an unexplained gap
  // between the by-source counts and the group total.
  cancelledOrNoShowBookingGroups: number;
  // All APPOINTMENT_SOURCES + "Not recorded", zero rows kept so the table
  // is stable across periods. Active groups only.
  bySource: SourceCount[];
  // Sorted by active count desc then label for a readable ranking; ties
  // broken alphabetically so the order is deterministic. Includes a campaign
  // whose groups are ALL cancelled/no-show (0 active, N cancelled) so it
  // isn't silently dropped from the table.
  byCampaign: BookingCampaignCount[];
}

function sortByCountDesc(a: CampaignCount, b: CampaignCount): number {
  return b.count - a.count || a.label.localeCompare(b.label);
}

interface ActiveCancelledTally {
  active: number;
  cancelled: number;
}

export function summarizeBookings(rows: readonly AppointmentSourceRow[]): BookingSourceStats {
  const groups = groupBookings(rows);
  const active = groups.filter((g) => g.active);
  const cancelledOrNoShow = groups.length - active.length;

  // Tallied over EVERY group (not just active) so a source/campaign whose
  // groups are all cancelled/no-show still gets a row — 0 active, N
  // cancelled — instead of silently vanishing from the table.
  const sourceTally = new Map<AppointmentSource | null, ActiveCancelledTally>();
  for (const s of APPOINTMENT_SOURCES) sourceTally.set(s, { active: 0, cancelled: 0 });
  sourceTally.set(null, { active: 0, cancelled: 0 });
  for (const g of groups) {
    const t = sourceTally.get(g.source) ?? { active: 0, cancelled: 0 };
    if (g.active) t.active += 1;
    else t.cancelled += 1;
    sourceTally.set(g.source, t);
  }

  const bySource: SourceCount[] = [
    ...APPOINTMENT_SOURCES.map((s) => ({
      source: s,
      label: APPOINTMENT_SOURCE_LABEL[s],
      count: sourceTally.get(s)?.active ?? 0,
      cancelled: sourceTally.get(s)?.cancelled ?? 0,
    })),
    {
      source: null,
      label: SOURCE_NOT_RECORDED_LABEL,
      count: sourceTally.get(null)?.active ?? 0,
      cancelled: sourceTally.get(null)?.cancelled ?? 0,
    },
  ];

  const campaignTally = new Map<string, ActiveCancelledTally>();
  for (const g of groups) {
    const label = attributionCampaignLabel(g.attribution) ?? NO_CAMPAIGN_LABEL;
    const t = campaignTally.get(label) ?? { active: 0, cancelled: 0 };
    if (g.active) t.active += 1;
    else t.cancelled += 1;
    campaignTally.set(label, t);
  }
  const byCampaign: BookingCampaignCount[] = Array.from(campaignTally.entries())
    .map(([label, t]) => ({ label, count: t.active, cancelled: t.cancelled }))
    .sort(sortByCountDesc);

  return {
    totalBookingGroups: groups.length,
    activeBookingGroups: active.length,
    cancelledOrNoShowBookingGroups: cancelledOrNoShow,
    bySource,
    byCampaign,
  };
}

export interface MessageKindCount {
  kind: ContactMessageKind;
  label: string;
  count: number;
}

export interface MessageStatusCount {
  status: ContactMessageStatus;
  label: string;
  count: number;
}

export interface MessageFormLocationCount {
  // null = "Not recorded" (every message received before 0156).
  location: ContactFormLocation | null;
  label: string;
  count: number;
}

export interface WebsiteMessageStats {
  total: number;
  byKind: MessageKindCount[];
  // Every CONTACT_FORM_LOCATIONS value + "Not recorded", zero rows kept so
  // the table is stable across periods (same as bySource).
  byFormLocation: MessageFormLocationCount[];
  byStatus: MessageStatusCount[];
  bookedCount: number;
  // booked / total. Never a division by zero — null (not 0 or NaN) when
  // there were no messages in the period at all, so the page can say "no
  // messages this period" instead of a misleading 0%.
  bookedRate: number | null;
  byCampaign: CampaignCount[];
}

export function summarizeMessages(rows: readonly ContactMessageSourceRow[]): WebsiteMessageStats {
  const total = rows.length;

  const kindCounts = new Map<ContactMessageKind, number>();
  for (const k of CONTACT_MESSAGE_KINDS) kindCounts.set(k, 0);
  const statusCounts = new Map<ContactMessageStatus, number>();
  for (const s of CONTACT_MESSAGE_STATUSES) statusCounts.set(s, 0);
  const campaignCounts = new Map<string, number>();
  const locationCounts = new Map<ContactFormLocation | null, number>();
  for (const l of CONTACT_FORM_LOCATIONS) locationCounts.set(l, 0);
  locationCounts.set(null, 0);

  for (const r of rows) {
    const location = isContactFormLocation(r.form_location) ? r.form_location : null;
    locationCounts.set(location, (locationCounts.get(location) ?? 0) + 1);
    const kind = isContactMessageKind(r.kind) ? r.kind : "general";
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
    const status = isContactMessageStatus(r.status) ? r.status : "new";
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    const label = attributionCampaignLabel(toAttribution(r.attribution)) ?? NO_CAMPAIGN_LABEL;
    campaignCounts.set(label, (campaignCounts.get(label) ?? 0) + 1);
  }

  const bookedCount = statusCounts.get("booked") ?? 0;

  return {
    total,
    byKind: CONTACT_MESSAGE_KINDS.map((k) => ({
      kind: k,
      label: CONTACT_MESSAGE_KIND_LABEL[k],
      count: kindCounts.get(k) ?? 0,
    })),
    byFormLocation: [
      ...CONTACT_FORM_LOCATIONS.map((l) => ({
        location: l,
        label: CONTACT_FORM_LOCATION_LABEL[l],
        count: locationCounts.get(l) ?? 0,
      })),
      {
        location: null,
        label: FORM_LOCATION_NOT_RECORDED_LABEL,
        count: locationCounts.get(null) ?? 0,
      },
    ],
    byStatus: CONTACT_MESSAGE_STATUSES.map((s) => ({
      status: s,
      label: CONTACT_MESSAGE_STATUS_LABEL[s],
      count: statusCounts.get(s) ?? 0,
    })),
    bookedCount,
    bookedRate: total > 0 ? bookedCount / total : null,
    byCampaign: Array.from(campaignCounts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort(sortByCountDesc),
  };
}
