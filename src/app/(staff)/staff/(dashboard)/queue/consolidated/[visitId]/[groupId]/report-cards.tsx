import type { ReactNode } from "react";
import Link from "next/link";
import { manilaDateTime } from "@/lib/dates/manila";
import { testStatusLabel } from "@/lib/results/status-filter";
import { codeDuplicatesName, reportHeadlineStatus } from "@/lib/results/consolidated-reports";

export interface ReportCardData {
  resultId: string;
  /** Any member's id — the staff PDF route resolves the shared result from it. */
  pdfTestRequestId: string;
  members: {
    id: string;
    code: string;
    name: string;
    status: string;
    releasedAt: string | null;
  }[];
  finalisedAt: string | null;
  finalisedBy: string | null;
  amendmentCount: number;
  lastAmendment: { at: string; reason: string; by: string | null } | null;
  /** Every edit, newest first. Amendment seq N replaced version N. */
  history: { seq: number; at: string; reason: string; by: string | null }[];
  /** Set when the viewer may edit this report (staff_can_read_finished_result). */
  editHref: string | null;
}

const BADGE: Record<string, string> = {
  released: "bg-emerald-50 text-emerald-700 border-emerald-200",
  ready_for_release: "bg-sky-50 text-sky-700 border-sky-200",
  result_uploaded: "bg-sky-50 text-sky-700 border-sky-200",
};

/**
 * One card per finished report for this visit + report group.
 *
 * The stored PDF is the report of record — it is what the patient received,
 * rendered with the reference ranges in force at the time — so the card links
 * it rather than re-rendering values from today's template (a range edited
 * since would disagree with the PDF). "Edit results" opens the values in
 * place (`?edit=<resultId>`, rendered by the page into `editForm`).
 */
export function ReportCards({
  reports,
  groupName,
  awaitingPaymentHint,
  editForm,
}: {
  reports: ReportCardData[];
  groupName: string;
  awaitingPaymentHint: string | null;
  editForm: { resultId: string; node: ReactNode } | null;
}) {
  return (
    <div className="mt-6 space-y-4">
      {reports.map((rep, i) => {
        const headline = reportHeadlineStatus(rep.members.map((m) => m.status));
        const releasedAt = rep.members.reduce<string | null>(
          (latest, m) => (m.releasedAt && (!latest || m.releasedAt > latest) ? m.releasedAt : latest),
          null,
        );
        return (
          <section
            key={rep.resultId}
            id={`result-${rep.resultId}`}
            className="scroll-mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
                  {reports.length > 1 ? `${groupName} report ${i + 1}` : `${groupName} report`}
                  <span className="ml-2 text-sm font-semibold text-[color:var(--color-brand-text-soft)]">
                    ({rep.members.length} {rep.members.length === 1 ? "test" : "tests"})
                  </span>
                </h2>
                <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
                  Finalised {rep.finalisedAt ? manilaDateTime(rep.finalisedAt) : "—"}
                  {rep.finalisedBy ? ` by ${rep.finalisedBy}` : ""}
                  {headline === "released" && releasedAt
                    ? ` · Released ${manilaDateTime(releasedAt)}`
                    : ""}
                </p>
              </div>
              <span
                className={`inline-block rounded-md border px-2 py-0.5 text-xs font-semibold ${BADGE[headline] ?? "bg-slate-50 text-slate-700 border-slate-200"}`}
              >
                {testStatusLabel(headline)}
              </span>
            </div>

            {headline === "ready_for_release" ? (
              <p
                role="status"
                className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
              >
                {awaitingPaymentHint
                  ? `Not released to the patient yet — ${awaitingPaymentHint}`
                  : "Not released to the patient yet. Release it from the visit page."}
              </p>
            ) : headline === "result_uploaded" ? (
              <p
                role="status"
                className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
              >
                Not released to the patient yet — waiting for pathologist sign-off.
              </p>
            ) : null}

            {rep.lastAmendment ? (
              <p className="mt-3 rounded-lg border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-900">
                <span className="font-semibold">
                  Edited {manilaDateTime(rep.lastAmendment.at)}
                  {rep.lastAmendment.by ? ` by ${rep.lastAmendment.by}` : ""}
                  {rep.amendmentCount > 1 ? ` (edited ${rep.amendmentCount} times)` : ""}
                </span>{" "}
                — {rep.lastAmendment.reason}
              </p>
            ) : null}

            <ul className="mt-4 flex flex-col gap-1 text-sm">
              {rep.members.map((m) => (
                <li key={m.id} className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium text-[color:var(--color-brand-navy)]">{m.name}</span>
                  {codeDuplicatesName(m.code, m.name) ? null : (
                    <span className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                      {m.code}
                    </span>
                  )}
                  {m.status !== headline ? (
                    <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                      · {testStatusLabel(m.status)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <a
                href={`/staff/results/${rep.pdfTestRequestId}/pdf`}
                target="_blank"
                rel="noopener"
                className="inline-flex min-h-[44px] items-center rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
              >
                View PDF →
              </a>
              {rep.editHref && editForm?.resultId !== rep.resultId ? (
                <Link
                  href={rep.editHref}
                  scroll={false}
                  className="inline-flex min-h-[44px] items-center rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-50"
                >
                  Edit results
                </Link>
              ) : null}
            </div>

            {editForm?.resultId === rep.resultId ? editForm.node : null}

            {rep.history.length > 0 ? (
              <div className="mt-5 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-3">
                <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  Edit history
                </p>
                <p className="mt-1 text-xs">
                  <a
                    href={`/staff/results/${rep.pdfTestRequestId}/pdf`}
                    target="_blank"
                    rel="noopener"
                    className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
                  >
                    Current version (v{rep.amendmentCount + 1})
                  </a>
                </p>
                <ul className="mt-2 grid gap-2 text-xs">
                  {rep.history.map((h) => (
                    <li key={h.seq} className="rounded-md bg-white px-3 py-2">
                      <p className="font-semibold text-[color:var(--color-brand-navy)]">
                        v{h.seq + 1} · {manilaDateTime(h.at)} · {h.by ?? "—"}
                      </p>
                      <p className="mt-1 text-[color:var(--color-brand-text-mid)]">{h.reason}</p>
                      <a
                        href={`/staff/results/${rep.pdfTestRequestId}/pdf?version=${h.seq}`}
                        target="_blank"
                        rel="noopener"
                        className="mt-1 inline-block text-[10px] font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
                      >
                        View replaced version (v{h.seq})
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
