/** Spec §3: a tab that shrank by more than 5% since the last good run is not trusted (sort/filter/truncation mid-edit). */
export function checkSnapshot(current: number, previous: number | undefined) {
  if (previous === undefined || previous <= 0 || current >= previous * 0.95) return { suspect: false as const };
  return { suspect: true as const, previous, current, shrinkPct: Math.round(((previous - current) / previous) * 100) };
}
