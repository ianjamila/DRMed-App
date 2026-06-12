"use client";

const VIEW_W = 1000;
const Y = 23;

// Evenly spaced node x-positions with a margin so the line breathes.
function nodeX(i: number, n: number): number {
  const margin = 40;
  return margin + (i * (VIEW_W - margin * 2)) / (n - 1);
}

// A flat ECG baseline with a small QRS pulse between each pair of nodes.
function buildPath(n: number): string {
  let d = `M0,${Y} `;
  for (let i = 0; i < n - 1; i++) {
    const a = nodeX(i, n);
    const b = nodeX(i + 1, n);
    const mid = (a + b) / 2;
    d += `L${a},${Y} L${mid - 22},${Y} ${mid - 10},${Y - 16} ${mid},${Y + 18} ${mid + 10},${Y - 12} ${mid + 22},${Y} `;
  }
  d += `L${nodeX(n - 1, n)},${Y} L${VIEW_W},${Y}`;
  return d;
}

/**
 * Sticky ECG progress indicator. The cyan "live" stroke fills up to the current
 * step, nodes light as they complete, and the active node beats. Labels collapse
 * to just the active one on narrow screens. Reduced motion is respected via CSS.
 */
export function EcgProgress({
  steps,
  current,
}: {
  steps: string[];
  current: number;
}) {
  const n = steps.length;
  const path = buildPath(n);
  // Fraction of the track drawn = progress through the steps.
  const progress = n > 1 ? current / (n - 1) : 0;
  const dashoffset = 100 * (1 - progress);

  return (
    <div className="sticky top-0 z-40 border-b border-[color:var(--color-warm-line-soft)] bg-[rgba(251,249,245,0.96)] backdrop-blur-[8px]">
      <div className="mx-auto max-w-[760px] px-5 pb-1 pt-2.5">
        <svg
          className="block h-[46px] w-full overflow-visible"
          viewBox={`0 0 ${VIEW_W} 46`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            d={path}
            fill="none"
            stroke="var(--color-warm-line)"
            strokeWidth={1.6}
          />
          <path
            d={path}
            pathLength={100}
            fill="none"
            stroke="var(--color-brand-cyan)"
            strokeWidth={2}
            strokeLinecap="round"
            style={{
              filter: "drop-shadow(0 0 4px rgba(8,168,226,.45))",
              strokeDasharray: 100,
              strokeDashoffset: dashoffset,
              transition: "stroke-dashoffset .9s cubic-bezier(.2,.7,.3,1)",
            }}
          />
          {steps.map((_, i) => {
            const cx = nodeX(i, n);
            const done = i < current;
            const now = i === current;
            return (
              <circle
                key={i}
                cx={cx}
                cy={Y}
                r={6}
                className={`wizard-prog-node${done ? " done" : ""}${now ? " now" : ""}`}
              />
            );
          })}
        </svg>
        <div className="flex justify-between px-1.5 pb-2">
          {steps.map((label, i) => (
            <span
              key={label}
              className={`flex-1 text-center text-[10.5px] font-bold uppercase tracking-[0.04em] ${
                i === current
                  ? "text-[color:var(--color-brand-cyan-text)]"
                  : "text-[color:var(--color-ink-soft)] max-[480px]:invisible"
              }`}
            >
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
