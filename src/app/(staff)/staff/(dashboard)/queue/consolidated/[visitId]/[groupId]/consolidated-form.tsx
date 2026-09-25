"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { claimConsolidated, finaliseConsolidated } from "./actions";
import type { ConsolidatedFormTemplate, ConsolidatedFormVisit } from "./page";
import { normalisePatientSex } from "@/lib/results/types";
import { ConsolidatedValuesTable, useConsolidatedValues } from "./consolidated-values-table";

interface Props {
  group: { id: string; code: string; name: string };
  template: ConsolidatedFormTemplate;
  visit: ConsolidatedFormVisit;
  orderedServiceCodes: string[];
  testRequestIds: string[];
  enabledParamIds: string[];
  claimedBy: string | null;
  myStaffId: string;
  /** Set when the visit is still waiting for payment (item 10) — replaces the
   * claim button with a notice. Server action enforces the same gate. */
  claimBlockedHint: string | null;
  /** The visit already has a finished report for this group (shown above the
   * form by the page) — these fields are for the tests added since. */
  hasFinishedReports: boolean;
  /** Server-rendered claim history + Unclaim, shown above the form. */
  claimPanel?: React.ReactNode;
}

export function ConsolidatedForm(props: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [deferredReason, setDeferredReason] = useState<
    "payment" | "consent" | "signoff" | null
  >(null);

  // Derived server-side from report_group_service_params — identity-based, so
  // renaming a parameter in the admin editor can't silently disable a field.
  const enabledParamIds = new Set(props.enabledParamIds);

  // Filter params by gender for this patient, then sort by sort_order.
  // patients.sex is stored as 'male'/'female' in the DB; template params use
  // 'F'/'M'. normalisePatientSex bridges the two shapes.
  const patientSex = normalisePatientSex(props.visit.patients.sex);
  const params = props.template.result_template_params
    .filter((p) => !p.gender || p.gender === patientSex)
    .sort((a, b) => a.sort_order - b.sort_order);

  const { values, updateSi, updateConv, payload: buildPayload } = useConsolidatedValues();

  const isClaimedByMe = props.claimedBy === props.myStaffId;

  function handleClaim() {
    setError(null);
    startTransition(async () => {
      const res = await claimConsolidated({
        testRequestIds: props.testRequestIds,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  function handleFinalise() {
    setError(null);
    const payload = buildPayload(params, enabledParamIds);

    startTransition(async () => {
      const res = await finaliseConsolidated({
        visitId: props.visit.id,
        groupId: props.group.id,
        testRequestIds: props.testRequestIds,
        values: payload,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (res.data.releaseDeferred) {
        // Stay on the page so the medtech sees the report is finalised but
        // not yet in the patient's hands — and why.
        setDeferredReason(res.data.deferredReason ?? "payment");
        return;
      }
      // Stay here: the page re-renders with the new report card (and its
      // PDF) above, which is the medtech's confirmation of what was sent.
      router.refresh();
    });
  }

  return (
    <>
      {props.claimPanel}

      <section className="mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        {deferredReason ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">
              Report finalised — release deferred:{" "}
              {deferredReason === "payment"
                ? "visit not yet paid (HMO visits are exempt). Record the payment, then come back and release these results — only packages release on their own"
                : deferredReason === "consent"
                  ? "patient consent not on file"
                  : "one or more of these tests requires pathologist sign-off before it can be released"}
            </p>
            <button
              type="button"
              onClick={() => router.push("/staff/queue")}
              className="mt-3 min-h-[44px] rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
            >
              Back to queue
            </button>
          </div>
        ) : !isClaimedByMe ? (
          <div>
            <p className="text-sm text-[color:var(--color-brand-text-mid)]">
              {props.claimedBy
                ? "This report is claimed by another medtech."
                : props.claimBlockedHint
                  ? "This report is unassigned."
                  : "This report is unassigned. Claim it to start working on it."}
            </p>
            {!props.claimedBy ? (
              props.claimBlockedHint ? (
                <p
                  role="status"
                  className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
                >
                  {props.claimBlockedHint}
                </p>
              ) : (
                <div className="mt-4">
                  <button
                    onClick={handleClaim}
                    disabled={pending}
                    className="min-h-[44px] rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
                  >
                    {pending ? "Claiming…" : "Claim this report"}
                  </button>
                </div>
              )
            ) : null}
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleFinalise();
            }}
            className="space-y-4"
          >
            <div>
              <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
                {props.hasFinishedReports ? "Enter the remaining results" : "Enter result values"}
              </h2>
              <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
                Rows for un-ordered tests are greyed out. Enter SI or
                conventional values — the other converts automatically.
              </p>
            </div>

            {params.length > 0 &&
            props.orderedServiceCodes.length > 0 &&
            enabledParamIds.size === 0 ? (
              <p
                className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700"
                role="alert"
              >
                Every field below is disabled — not because nothing was
                ordered, but because none of the ordered tests map to a field
                on this template. This is a configuration problem, not a
                data-entry one. Report it to an admin instead of working
                around it.
              </p>
            ) : null}

            <ConsolidatedValuesTable
              params={params}
              enabled={enabledParamIds}
              values={values}
              onSi={updateSi}
              onConv={updateConv}
              disabled={pending}
            />

            {error ? (
              <p className="rounded-lg border border-destructive bg-destructive/5 p-3 text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={pending}
              className="min-h-[44px] rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
              {pending ? "Finalising…" : "Finalise + release"}
            </button>
          </form>
        )}

        {error && !isClaimedByMe ? (
          <p className="mt-3 rounded-lg border border-destructive bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </section>

    </>
  );
}
