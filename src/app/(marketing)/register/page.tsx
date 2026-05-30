import type { Metadata } from "next";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = {
  title: "Register — drmed.ph",
  description: "Pre-register at DRMed Clinic & Laboratory and get your DRM-ID.",
};

export default function RegisterPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6 lg:py-14">
      <p className="text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">Pre-register</p>
      <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Get your DRM-ID
      </h1>
      <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
        Fill this once and we&apos;ll email your DRM-ID — skip the counter form on arrival. Booking is separate; to book a
        visit, use <a className="underline" href="/schedule">Schedule</a>.
      </p>
      <div className="mt-6">
        <RegisterForm />
      </div>
    </main>
  );
}
