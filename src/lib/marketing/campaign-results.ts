/**
 * Pure aggregation for "real bookings" in the admin Marketing → Ad
 * Performance tab (`/staff/marketing`). The page fetches appointment and
 * website-message ROWS (already windowed to the last 400 days and fetched
 * with `fetchAllRows`) and reduces them here, SERVER-SIDE, into daily counts
 * per (Manila date, campaign label). Only those counts — no names, ids,
 * contact details or raw attribution — cross to the client component, which
 * joins them against the admin's uploaded ad-spend CSV by a normalised
 * campaign-name match. No `server-only`, no DB — vitest-tested in
 * `campaign-results.test.ts`.
 *
 * Booking-group folding and the cancelled/no-show rule mirror
 * `src/lib/marketing/booking-sources.ts` exactly (same product decision,
 * different grain: this file buckets by day + campaign instead of totalling
 * a whole period) — kept as a separate copy because that file is owned by
 * another PR's edits in-flight on this branch.
 */
import { parseAttributionCookie, type Attribution } from "@/lib/analytics/attribution";
import { attributionCampaignLabel } from "@/lib/appointments/source";
import { manilaISODate } from "@/lib/dates/manila";

// Same rule as booking-sources.ts: a booking GROUP counts as cancelled/no-show
// only when EVERY row in it does.
const CANCELLED_OR_NO_SHOW = new Set(["cancelled", "no_show"]);

// The bucket a booking/message with no usable UTM campaign falls into. Never
// shown to the admin directly and never matched against an uploaded ad
// campaign (organic/direct traffic can't have ad spend) — callers exclude it
// before joining.
export const NO_CAMPAIGN_LABEL = "No ad tag (direct / organic)";

export interface CampaignResultAppointmentRow {
  id: string;
  booking_group_id: string | null;
  status: string;
  attribution: unknown;
  created_at: string;
}

export interface CampaignResultMessageRow {
  id: string;
  kind: string;
  status: string;
  attribution: unknown;
  created_at: string;
}

/** One Manila calendar day × campaign-label bucket. All fields are counts only. */
export interface DailyCampaignCounts {
  date: string; // Manila ISO date (YYYY-MM-DD)
  campaign: string; // the raw utm_campaign label, or NO_CAMPAIGN_LABEL
  bookings: number; // active booking groups
  cancelledBookings: number; // booking groups where every row is cancelled/no_show
  messages: number; // website messages
  corporateMessages: number; // subset of `messages` with kind = "corporate"
}

function toAttribution(value: unknown): Attribution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return parseAttributionCookie(JSON.stringify(value));
}

/**
 * Lowercase, trim, and collapse any run of whitespace/underscores/hyphens/
 * dots into a single space. Meta and Google export the same campaign under
 * slightly different punctuation ("Beat_the_Hospital-Price" vs "Beat the
 * Hospital Price."), and the clinic's own utm_campaign values are typed by
 * hand into ad-platform UIs, so an exact string match would silently show
 * every real campaign as unmatched.
 */
export function normaliseCampaignName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_.-]+/g, " ")
    .trim();
}

/**
 * Fold appointment rows into booking GROUPS (by `booking_group_id`, falling
 * back to the row's own id), then bucket each group's Manila day (the
 * group's FIRST row's `created_at` — every row of a group shares a source/
 * attribution stamp, so any row's date would do) and campaign label. Fold
 * message rows individually by their own day/campaign. Returns buckets in
 * first-seen order; empty buckets are never created, so callers must handle
 * a missing (date, campaign) pair as zero.
 */
export function buildDailyCampaignCounts(
  apptRows: readonly CampaignResultAppointmentRow[],
  msgRows: readonly CampaignResultMessageRow[],
): DailyCampaignCounts[] {
  const order: string[] = [];
  const buckets = new Map<string, DailyCampaignCounts>();
  const bucketFor = (date: string, campaign: string): DailyCampaignCounts => {
    const key = `${date}\u0000${campaign}`;
    let b = buckets.get(key);
    if (!b) {
      b = { date, campaign, bookings: 0, cancelledBookings: 0, messages: 0, corporateMessages: 0 };
      buckets.set(key, b);
      order.push(key);
    }
    return b;
  };

  // Group appointment rows (insertion order preserved, same as groupBookings).
  const groupOrder: string[] = [];
  const groups = new Map<
    string,
    { attribution: Attribution | null; firstCreatedAt: string; statuses: string[] }
  >();
  for (const r of apptRows) {
    const key = r.booking_group_id ?? r.id;
    let g = groups.get(key);
    if (!g) {
      g = { attribution: toAttribution(r.attribution), firstCreatedAt: r.created_at, statuses: [] };
      groups.set(key, g);
      groupOrder.push(key);
    }
    g.statuses.push(r.status);
  }
  for (const key of groupOrder) {
    const g = groups.get(key)!;
    const date = manilaISODate(g.firstCreatedAt);
    if (!date) continue; // unparseable created_at — nothing sane to bucket it under
    const campaign = attributionCampaignLabel(g.attribution) ?? NO_CAMPAIGN_LABEL;
    const active = !g.statuses.every((s) => CANCELLED_OR_NO_SHOW.has(s));
    const bucket = bucketFor(date, campaign);
    if (active) bucket.bookings += 1;
    else bucket.cancelledBookings += 1;
  }

  for (const r of msgRows) {
    const date = manilaISODate(r.created_at);
    if (!date) continue;
    const campaign = attributionCampaignLabel(toAttribution(r.attribution)) ?? NO_CAMPAIGN_LABEL;
    const bucket = bucketFor(date, campaign);
    bucket.messages += 1;
    if (r.kind === "corporate") bucket.corporateMessages += 1;
  }

  return order.map((k) => buckets.get(k)!);
}

/** Keep only buckets whose Manila date falls within [fromISO, toISO], inclusive. Plain string compare — ISO dates sort lexicographically. */
export function filterDailyCampaignCountsByRange(
  counts: readonly DailyCampaignCounts[],
  fromISO: string,
  toISO: string,
): DailyCampaignCounts[] {
  return counts.filter((c) => c.date >= fromISO && c.date <= toISO);
}

/** One row of the admin's uploaded/sample ad data, already grouped by campaign name. */
export interface AdCampaignSpend {
  campaign: string;
  spend: number;
}

/** A matched campaign: the clinic's real counts next to that campaign's ad spend. */
export interface CampaignResultRow {
  campaign: string; // the ad platform's own spelling of the name
  spend: number;
  bookings: number;
  cancelledBookings: number;
  messages: number;
  corporateMessages: number;
  // spend / bookings; null (never Infinity/NaN) when bookings is 0, so the
  // UI can render "—" instead of a bogus peso figure.
  costPerBooking: number | null;
}

export interface CampaignResultsJoin {
  // Sorted by spend, descending.
  matched: CampaignResultRow[];
  totals: {
    spend: number;
    bookings: number;
    messages: number;
    costPerBooking: number | null;
  };
  // UTM campaign labels with bookings/messages in the period that matched no
  // uploaded ad campaign by normalised name. Sorted alphabetically.
  unmatchedClinicCampaigns: string[];
  // Uploaded ad campaigns with spend that matched no clinic booking/message
  // in the period. Sorted alphabetically.
  unmatchedAdCampaigns: string[];
}

/**
 * Join the clinic's daily counts (already filtered to the uploaded data's
 * date range) against the admin's ad-spend campaigns, matching by
 * `normaliseCampaignName`. `NO_CAMPAIGN_LABEL` buckets are excluded from both
 * the join and the unmatched-clinic list — organic/direct traffic has no ad
 * campaign to match and reporting it as "unmatched" would just be noise.
 */
export function joinCampaignResults(
  dailyCounts: readonly DailyCampaignCounts[],
  adCampaigns: readonly AdCampaignSpend[],
): CampaignResultsJoin {
  const clinicByNorm = new Map<
    string,
    {
      labels: Set<string>;
      bookings: number;
      cancelledBookings: number;
      messages: number;
      corporateMessages: number;
    }
  >();
  for (const c of dailyCounts) {
    if (c.campaign === NO_CAMPAIGN_LABEL) continue;
    const norm = normaliseCampaignName(c.campaign);
    if (!norm) continue;
    let e = clinicByNorm.get(norm);
    if (!e) {
      e = { labels: new Set(), bookings: 0, cancelledBookings: 0, messages: 0, corporateMessages: 0 };
      clinicByNorm.set(norm, e);
    }
    e.labels.add(c.campaign);
    e.bookings += c.bookings;
    e.cancelledBookings += c.cancelledBookings;
    e.messages += c.messages;
    e.corporateMessages += c.corporateMessages;
  }

  const adByNorm = new Map<string, { labels: Set<string>; spend: number }>();
  for (const a of adCampaigns) {
    const norm = normaliseCampaignName(a.campaign);
    if (!norm) continue;
    let e = adByNorm.get(norm);
    if (!e) {
      e = { labels: new Set(), spend: 0 };
      adByNorm.set(norm, e);
    }
    e.labels.add(a.campaign);
    e.spend += a.spend;
  }

  const matched: CampaignResultRow[] = [];
  let totalSpend = 0;
  let totalBookings = 0;
  let totalMessages = 0;
  for (const [norm, ad] of adByNorm) {
    const clinic = clinicByNorm.get(norm);
    const bookings = clinic?.bookings ?? 0;
    const cancelledBookings = clinic?.cancelledBookings ?? 0;
    const messages = clinic?.messages ?? 0;
    const corporateMessages = clinic?.corporateMessages ?? 0;
    matched.push({
      campaign: [...ad.labels][0]!,
      spend: ad.spend,
      bookings,
      cancelledBookings,
      messages,
      corporateMessages,
      costPerBooking: bookings > 0 ? ad.spend / bookings : null,
    });
    totalSpend += ad.spend;
    totalBookings += bookings;
    totalMessages += messages;
  }
  matched.sort((a, b) => b.spend - a.spend);

  const unmatchedClinicCampaigns = [...clinicByNorm.entries()]
    .filter(([norm]) => !adByNorm.has(norm))
    .flatMap(([, e]) => [...e.labels])
    .sort((a, b) => a.localeCompare(b));

  const unmatchedAdCampaigns = [...adByNorm.entries()]
    .filter(([norm]) => !clinicByNorm.has(norm))
    .flatMap(([, e]) => [...e.labels])
    .sort((a, b) => a.localeCompare(b));

  return {
    matched,
    totals: {
      spend: totalSpend,
      bookings: totalBookings,
      messages: totalMessages,
      costPerBooking: totalBookings > 0 ? totalSpend / totalBookings : null,
    },
    unmatchedClinicCampaigns,
    unmatchedAdCampaigns,
  };
}
