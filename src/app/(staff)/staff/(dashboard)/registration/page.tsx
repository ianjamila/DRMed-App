import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { RegistrationPanel } from "./registration-panel";

export const metadata = {
  title: "Registration link — staff",
};

export const dynamic = "force-dynamic";

export default async function StaffRegistrationPage() {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    redirect("/staff");
  }

  const host = (await headers()).get("host") ?? "drmed.ph";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const url = `${proto}://${host}/register?src=staff_qr`;

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Registration link
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Share the public pre-registration page so patients can get a DRM-ID on their own phone — show the QR to scan, copy
          the link to text them, or print a poster for the desk. Registration is optional; it just saves counter time on
          arrival.
        </p>
      </header>
      <RegistrationPanel url={url} />
    </div>
  );
}
