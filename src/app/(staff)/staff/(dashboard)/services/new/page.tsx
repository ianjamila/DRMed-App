import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { ServiceForm } from "../service-form";
import { Panel } from "@/components/ui/panel";

export const metadata = {
  title: "New service — staff",
};

export default async function NewServicePage() {
  await requireAdminStaff();
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/services"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Services
      </Link>
      <h1 className="mt-3 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        New service
      </h1>
      <Panel className="mt-6 p-6">
        <ServiceForm />
      </Panel>
    </div>
  );
}
