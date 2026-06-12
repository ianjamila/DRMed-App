import {
  KeyRound,
  FileDown,
  History,
  ShieldCheck,
  ArrowRight,
  Lock,
} from "lucide-react";
import Image from "next/image";
import { SectionHeading, PillLink } from "@/components/marketing/ui";
import { Reveal } from "@/components/marketing/motion";

const PORTAL_FEATURES = [
  {
    icon: KeyRound,
    title: "Secure PIN Access",
    description:
      "Sign in using the claim password printed on your official laboratory receipt.",
  },
  {
    icon: FileDown,
    title: "PDF Download",
    description:
      "Download official signed lab results, ready to share with your physician.",
  },
  {
    icon: History,
    title: "Full History Access",
    description: "View all past results. Track your health trends over time.",
  },
  {
    icon: ShieldCheck,
    title: "RA 10173 Compliant",
    description:
      "All records handled in accordance with the Philippine Data Privacy Act.",
  },
] as const;

export function PortalPromo() {
  return (
    <section
      id="portal"
      className="bg-[color:var(--color-warm-sand)] py-[72px]"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid items-start gap-9 lg:grid-cols-[1.1fr_0.9fr]">
          {/* ── Left column ── */}
          <div>
            <SectionHeading
              eyebrow="Patient Portal"
              title="Your results,"
              accent="securely accessible."
              description="No more waiting in queues. Access your complete lab results online, anytime — secured with your receipt-issued claim password and Philippine Data Privacy Act compliance."
            />

            {/* Feature grid — mt-7.5 = 30px (Tailwind 3.x supports fractional values) */}
            <div className="mt-[30px] grid grid-cols-1 gap-3 sm:grid-cols-2">
              {PORTAL_FEATURES.map(({ icon: Icon, title, description }) => (
                <Reveal key={title}>
                  <div className="flex items-start gap-[15px] rounded-[18px] bg-white p-[20px_22px] shadow-[var(--shadow-warm-sm)]">
                    <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-full bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]">
                      <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
                    </span>
                    <div>
                      <h3 className="text-[15px] font-bold text-[color:var(--color-brand-navy)]">
                        {title}
                      </h3>
                      <p className="mt-1 text-[13.5px] leading-[1.5] text-[color:var(--color-ink-soft)]">
                        {description}
                      </p>
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>

          {/* ── Right column ── */}
          <div>
            {/* Navy CTA card */}
            <Reveal>
              <div className="relative overflow-hidden rounded-[24px] bg-[color:var(--color-brand-navy)] p-[34px] text-white shadow-[var(--shadow-warm-lg)]">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[color:var(--color-brand-cyan-on-navy)]">
                  Secure Patient Sign-In
                </p>
                <h3 className="mt-3 font-[family-name:var(--font-display)] text-[34px] leading-[1.1]">
                  Access My Results
                </h3>
                <p className="mt-3 max-w-[380px] text-[14px] text-white/72">
                  Use your DRM-ID and the Secure PIN printed on your receipt.
                </p>
                <PillLink
                  href="/portal/login"
                  variant="cyan"
                  className="mt-[22px]"
                >
                  Open Patient Portal <ArrowRight className="h-[18px] w-[18px]" />
                </PillLink>
                <div className="mt-6 flex items-center gap-2 text-xs text-white/55">
                  <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                  Protected under the Philippine Data Privacy Act (RA 10173).
                </div>
              </div>
            </Reveal>

            {/* Pending photo slot #3 */}
            <Reveal className="mt-[18px]">
              <Image
                src="/photos/results-at-home.jpg"
                alt="Patient reviewing lab results on a phone at home in soft morning light"
                width={1400}
                height={870}
                sizes="(min-width: 1024px) 600px, 100vw"
                className="h-[230px] w-full rounded-[20px] object-cover"
              />
              <p className="mt-2 text-[11px] italic text-[color:var(--color-ink-soft)]">
                Your results, anytime — from the comfort of home
              </p>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}
