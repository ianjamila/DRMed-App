import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCandidatePairs } from "@/lib/patients/find-duplicates";
import { RECENT_MERGES_PAGE_SIZE } from "@/lib/patients/merge-fields";
import { PaginationRangeLabel, pagerControlClass } from "@/components/staff/list-pagination";
import { loadRecentMerges } from "../actions";
import { CandidatesClient } from "./candidates-client";

export const metadata = { title: "Possible duplicate patients" };
export const dynamic = "force-dynamic";

export default async function CandidatesPage({
  searchParams,
}: {
  searchParams: Promise<{ tier?: string; mpage?: string }>;
}) {
  await requireAdminStaff();
  const sp = await searchParams;
  const minTier = sp.tier === "weak" ? "weak" : "probable";
  const mpage = Math.max(1, Number.parseInt(sp.mpage ?? "1", 10) || 1);
  const admin = createAdminClient();
  const [pairs, recent] = await Promise.all([
    loadCandidatePairs(admin, { minTier }),
    loadRecentMerges(mpage),
  ]);
  const pageCount = Math.max(1, Math.ceil(recent.total / RECENT_MERGES_PAGE_SIZE));
  const hrefFor = (p: number) => {
    const q = new URLSearchParams();
    if (minTier === "weak") q.set("tier", "weak");
    if (p > 1) q.set("mpage", String(p));
    const s = q.toString();
    return `/staff/admin/patient-merge/candidates${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Possible duplicate patients</h1>
          <p className="text-sm text-slate-500">
            Ranked candidate pairs. Review each before merging — merges can be undone within 30 days.
          </p>
        </div>
        <Link href="/staff/admin/patient-merge" className="text-sm font-semibold text-cyan-700 hover:underline">
          Manual merge by DRM-ID →
        </Link>
      </div>

      <div className="flex gap-2 text-sm">
        <Link href="/staff/admin/patient-merge/candidates" className={minTier === "probable" ? "font-bold" : "text-slate-500"}>Probable+</Link>
        <Link href="/staff/admin/patient-merge/candidates?tier=weak" className={minTier === "weak" ? "font-bold" : "text-slate-500"}>Include weak</Link>
      </div>

      <CandidatesClient pairs={pairs} recent={recent.rows} />

      {recent.total > RECENT_MERGES_PAGE_SIZE && (
        <nav aria-label="Recently merged pages" className="flex items-center justify-between gap-3">
          <PaginationRangeLabel page={recent.page} size={RECENT_MERGES_PAGE_SIZE} total={recent.total} noun="merge" />
          <div className="flex gap-2">
            {recent.page > 1 ? <Link href={hrefFor(recent.page - 1)} className={pagerControlClass}>Previous</Link> : null}
            {recent.page < pageCount ? <Link href={hrefFor(recent.page + 1)} className={pagerControlClass}>Next</Link> : null}
          </div>
        </nav>
      )}
    </div>
  );
}
