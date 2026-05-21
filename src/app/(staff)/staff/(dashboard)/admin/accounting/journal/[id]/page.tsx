import { notFound } from "next/navigation";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { getJournalEntryAction } from "@/lib/actions/accounting/journal-entries";
import { JournalDetailClient } from "./journal-detail-client";

export const metadata = { title: "Journal entry — DRMed" };
export const dynamic = "force-dynamic";

export default async function JournalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminStaff();
  const { id } = await params;
  const r = await getJournalEntryAction(id);
  if (!r.ok || !r.data) notFound();
  return <JournalDetailClient je={r.data} />;
}
