import { Banknote, QrCode, Landmark, CreditCard } from "lucide-react";
import { SectionHeading } from "@/components/marketing/ui";
import { Reveal } from "@/components/marketing/motion";

const PAYMENT_METHODS = [
  {
    icon: Banknote,
    title: "Cash",
    description: "Pay over the counter at the clinic.",
  },
  {
    icon: QrCode,
    title: "QR Payments",
    description: "GCash / PayMaya or other QR-supported wallets.",
  },
  {
    icon: Landmark,
    title: "Bank Transfer",
    description: "Local bank transfer or online banking.",
  },
  {
    icon: CreditCard,
    title: "Card Payments",
    description: "Debit and credit card accepted.",
  },
] as const;

export function Payments() {
  return (
    <section className="py-[72px]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Payment Options"
          title={
            <>
              100%{" "}
              <span className="italic text-[color:var(--color-brand-cyan-text)]">
                convenient
              </span>{" "}
              payments.
            </>
          }
          description="No more long waiting times inside crowded hospitals or health centers. Accessible, hassle-free, effortless payment options are available for your visit."
        />

        <div className="mt-10 grid grid-cols-1 gap-[14px] sm:grid-cols-2 lg:grid-cols-4">
          {PAYMENT_METHODS.map(({ icon: Icon, title, description }) => (
            <Reveal key={title}>
              <div className="rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-6 shadow-[var(--shadow-warm-sm)] transition-[transform,box-shadow] duration-[250ms] hover:-translate-y-1 hover:shadow-[var(--shadow-warm-lg)]">
                <span className="grid h-[46px] w-[46px] place-items-center rounded-[14px] bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-base font-bold text-[color:var(--color-brand-navy)]">
                  {title}
                </h3>
                <p className="mt-1.5 text-[13.5px] text-[color:var(--color-ink-soft)]">
                  {description}
                </p>
              </div>
            </Reveal>
          ))}
        </div>

        <p className="mt-[22px] text-sm text-[color:var(--color-ink-soft)]">
          Need assistance? Our front desk will guide you through the payment
          method that works best for you.
        </p>
      </div>
    </section>
  );
}
