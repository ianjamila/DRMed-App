import { manilaDateTime } from "@/lib/dates/manila";
import type { ClaimRemark, HandedBack } from "@/lib/queue/claim-remarks";

// One test's claim history as a short list: claimed, unclaimed (with the
// reason), reassigned — oldest first. Shared by the lab queue's Remarks column,
// the results archive and the test pages so the wording never drifts.
// `max` keeps the newest N and folds the rest into "+N earlier".
export function ClaimRemarksList({
  remarks,
  max,
}: {
  remarks: readonly ClaimRemark[];
  max?: number;
}) {
  const hidden = max === undefined ? 0 : Math.max(0, remarks.length - max);
  const shown = remarks.slice(hidden);
  return (
    <ul className="space-y-1">
      {hidden > 0 ? (
        <li className="text-[color:var(--color-brand-text-soft)]">
          +{hidden} earlier
        </li>
      ) : null}
      {shown.map((r) => (
        <li
          key={r.key}
          className={
            r.notable
              ? "font-semibold text-amber-800"
              : "text-[color:var(--color-brand-text-mid)]"
          }
        >
          {r.text}
          <span className="block font-normal text-[color:var(--color-brand-text-soft)]">
            {manilaDateTime(r.at)}
          </span>
        </li>
      ))}
    </ul>
  );
}

// The test pages' "Claim history" block: the full list, no cap, with a heading
// matching the page's other small-caps labels.
export function ClaimHistory({
  remarks,
  className = "",
}: {
  remarks: readonly ClaimRemark[];
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        Claim history
      </p>
      {remarks.length === 0 ? (
        <p className="mt-0.5 text-xs text-[color:var(--color-brand-text-soft)]">
          Nobody has claimed this yet.
        </p>
      ) : (
        <div className="mt-1 text-xs">
          <ClaimRemarksList remarks={remarks} />
        </div>
      )}
    </div>
  );
}

// The Visit page's chip for a test that was put back in the queue at least
// once. The newest unclaim (who, and the reason) rides along as the tooltip
// and the accessible name; the test page's Claim history has the full story.
export function HandedBackBadge({ info }: { info: HandedBack | null }) {
  if (!info) return null;
  const label = `${info.count > 1 ? `Handed back ${info.count} times. Latest: ` : ""}${info.latest.text}, ${manilaDateTime(info.latest.at)}`;
  return (
    <div className="mt-1">
      <span
        title={label}
        aria-label={label}
        className="inline-block rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800"
      >
        handed back{info.count > 1 ? ` ×${info.count}` : ""}
      </span>
    </div>
  );
}
