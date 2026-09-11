// Pure formatter — no `server-only` import — so the Asia/Manila fix (A7: a
// booking's scheduled_at was rendered with the SERVER's clock instead of the
// clinic's, showing a 2:00 PM Manila slot as "6:00 AM" once Vercel — which
// runs UTC — took over from local dev) can be pinned by a unit test. Any
// code turning an appointment `scheduled_at` timestamptz into a patient- or
// staff-facing string should go through this rather than re-deriving
// `toLocaleString` options locally, so the timezone can't silently drop again.
export function formatManilaDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "long",
    timeStyle: "short",
  });
}
