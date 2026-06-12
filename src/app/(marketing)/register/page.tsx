import type { Metadata } from "next";
import { PageHero } from "@/components/marketing/page-hero";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = {
  title: "Register — drmed.ph",
  description: "Pre-register at DRMed Clinic & Laboratory and get your DRM-ID.",
};

export default function RegisterPage() {
  return (
    <>
      <PageHero
        eyebrow="Pre-register"
        title="Get your DRM-ID."
        description="Fill this once and we'll email your DRM-ID — skip the counter form on arrival. Booking is separate; to book a visit, use the Schedule page."
      />

      <section className="py-12 sm:py-16">
        <div className="mx-auto max-w-2xl px-4 sm:px-6">
          <div className="rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-8 shadow-[var(--shadow-warm-sm)]">
            <RegisterForm />
          </div>
          <p className="mt-4 text-sm text-[color:var(--color-ink-soft)]">
            Want to book a visit?{" "}
            <a
              className="text-[color:var(--color-brand-cyan-text)] underline underline-offset-2"
              href="/schedule"
            >
              Go to Schedule
            </a>
            .
          </p>
        </div>
      </section>
    </>
  );
}
