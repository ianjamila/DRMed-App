"use client";

import Link from "next/link";

// A print-friendly one-pager reception can keep at the desk. The print CSS
// hides all app chrome (sidebar, header, buttons) and prints only the guide.
export function PayDoctorsGuide() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <style>{`@media print {
        body * { visibility: hidden !important; }
        #pay-doctors-guide, #pay-doctors-guide * { visibility: visible !important; }
        #pay-doctors-guide { position: absolute; left: 0; top: 0; width: 100%; padding: 32px; border: none; }
      }`}</style>

      <div className="mb-4 flex items-center justify-between print:hidden">
        <Link
          href="/staff/admin/accounting/pf-payouts"
          className="text-sm font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Back to Pay doctors
        </Link>
        <button
          onClick={() => window.print()}
          className="min-h-11 rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-semibold text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          Print
        </button>
      </div>

      <article
        id="pay-doctors-guide"
        className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6"
      >
        <h1 className="font-heading text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
          How to pay doctors
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Quick guide for end-of-day doctor payments.
        </p>

        <h2 className="mt-5 text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Every day
        </h2>
        <ol className="mt-2 space-y-2 text-sm text-[color:var(--color-brand-navy)]">
          <li>
            <strong>1.</strong> Open <strong>Pay doctors</strong> in the sidebar
            (under the Pay doctors group).
          </li>
          <li>
            <strong>2.</strong> Stay on the <strong>Ready to pay</strong> tab. It
            shows each doctor and the total you owe them — the amount is already
            correct, no math needed.
          </li>
          <li>
            <strong>3.</strong> Send the doctor that amount by <strong>GCash</strong>{" "}
            (or cash), the way you normally do.
          </li>
          <li>
            <strong>4.</strong> Click <strong>Pay this doctor</strong>, choose how
            you paid, then <strong>Confirm</strong>.
          </li>
          <li>
            <strong>5.</strong> Repeat for each doctor. Paid doctors move to the{" "}
            <strong>Already paid</strong> tab.
          </li>
        </ol>

        <h2 className="mt-5 text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Important
        </h2>
        <ul className="mt-2 space-y-2 text-sm text-[color:var(--color-brand-navy)]">
          <li>
            • <strong>Waiting on insurance</strong> = do NOT pay yet. The app holds
            these until the HMO pays the clinic, then they move to{" "}
            <strong>Ready to pay</strong> on their own.
          </li>
          <li>
            • Clicking <strong>Pay this doctor</strong> only records the payment —
            it does not send money. You still send the GCash yourself.
          </li>
          <li>
            • Paying everyone in cash at once? Use{" "}
            <strong>Pay everyone (cash only)</strong>. For GCash, pay each doctor
            one at a time.
          </li>
        </ul>
      </article>
    </main>
  );
}
