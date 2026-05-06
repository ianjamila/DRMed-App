import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { physicianPhotoUrl } from "@/lib/physicians/photo";
import { PhysicianForm } from "../../physician-form";
import { PhotoUpload } from "./photo-upload";

export const metadata = { title: "Edit physician — staff" };

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditPhysicianPage({ params }: PageProps) {
  await requireAdminStaff();
  const { id } = await params;
  const admin = createAdminClient();

  const { data: physician } = await admin
    .from("physicians")
    .select(
      "id, slug, full_name, specialty, group_label, bio, is_active, display_order, photo_path",
    )
    .eq("id", id)
    .maybeSingle();
  if (!physician) notFound();

  const photoUrl = physicianPhotoUrl({
    slug: physician.slug,
    photo_path: physician.photo_path,
  });

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            <Link
              href="/staff/admin/physicians"
              className="hover:text-[color:var(--color-brand-navy)]"
            >
              ← Physicians
            </Link>
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {physician.full_name}
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            {physician.specialty}
          </p>
        </div>
        <Link
          href={`/staff/admin/physicians/${physician.id}/schedule`}
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
        >
          Schedule →
        </Link>
      </header>

      <section className="mb-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <h2 className="font-[family-name:var(--font-heading)] text-sm font-extrabold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Photo
        </h2>
        <div className="mt-3">
          <PhotoUpload physicianId={physician.id} currentUrl={photoUrl} />
        </div>
      </section>

      <PhysicianForm initial={physician} />
    </div>
  );
}
