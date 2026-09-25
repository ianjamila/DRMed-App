// "Sample" chip for a sample / training visit (0181). One component so the
// visit page, both queues and Visit Records all say it the same way.
export function SampleBadge({ size = "default" }: { size?: "default" | "compact" }) {
  return (
    <span
      title="Sample visit — training or testing. The patient is never contacted about it."
      className={`inline-block rounded-md border border-dashed border-violet-400 bg-violet-50 font-semibold uppercase tracking-wider text-violet-800 ${
        size === "compact" ? "px-1.5 py-0 text-[9px]" : "px-2 py-0.5 text-[10px]"
      }`}
    >
      Sample
    </span>
  );
}
