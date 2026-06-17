import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCandidatePairs } from "@/lib/patients/find-duplicates";
import { loadRecentMerges } from "../actions";
import { CandidatesClient } from "./candidates-client";

export const dynamic = "force-dynamic";

export default async function CandidatesPage({
  searchParams,
}: {
  searchParams: Promise<{ tier?: string }>;
}) {
  await requireAdminStaff();
  const sp = await searchParams;
  const minTier = sp.tier === "weak" ? "weak" : "probable";
  const admin = createAdminClient();
  const [pairs, recent] = await Promise.all([
    loadCandidatePairs(admin, { minTier }),
    loadRecentMerges(),
  ]);

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

      <CandidatesClient pairs={pairs} recent={recent} />
    </div>
  );
}
