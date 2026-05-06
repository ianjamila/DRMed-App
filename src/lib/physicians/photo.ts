// Resolve a physician's photo URL.
//
// During Phase 9 migration, freshly seeded physicians get a sentinel
// photo_path = "legacy/<slug>.jpg" — those still resolve to the static
// /public/doctors/<slug>.jpg shipped with the app. Once admin uploads
// via /staff/admin/physicians/[id]/edit, photo_path becomes a real
// storage key inside the public physician-photos bucket.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const BUCKET = "physician-photos";

export function physicianPhotoUrl(args: {
  slug: string;
  photo_path: string | null;
}): string {
  const { slug, photo_path } = args;
  if (!photo_path || photo_path.startsWith("legacy/")) {
    return `/doctors/${slug}.jpg`;
  }
  if (!SUPABASE_URL) return `/doctors/${slug}.jpg`;
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${photo_path}`;
}
