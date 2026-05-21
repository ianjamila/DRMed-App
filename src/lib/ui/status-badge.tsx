import { Badge } from "@/components/ui/badge";
import type { ComponentProps } from "react";

// Status colors for AP subledger entities. Maps status → tailwind palette.
// Posted is "brand-tinted" via brand-cyan/navy; other statuses use semantic
// palettes (gray draft, amber partial, green paid/active, red voided).
const STATUS_CLASS: Record<string, string> = {
  // bills
  draft: "bg-gray-100 text-gray-700 hover:bg-gray-100",
  posted: "bg-[color:var(--color-brand-cyan)]/15 text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-cyan)]/15",
  partially_paid: "bg-amber-100 text-amber-800 hover:bg-amber-100",
  paid: "bg-emerald-100 text-emerald-800 hover:bg-emerald-100",
  voided: "bg-red-100 text-red-800 hover:bg-red-100",
  // payment allocation / template active states
  active: "bg-emerald-100 text-emerald-800 hover:bg-emerald-100",
  inactive: "bg-gray-100 text-gray-500 hover:bg-gray-100",
  // JE status
  reversed: "bg-amber-100 text-amber-800 hover:bg-amber-100",
};

export function StatusBadge({
  status,
  className,
  ...rest
}: { status: string } & Omit<ComponentProps<typeof Badge>, "variant" | "children">) {
  const palette = STATUS_CLASS[status] ?? "bg-gray-100 text-gray-700 hover:bg-gray-100";
  return (
    <Badge
      variant="secondary"
      className={`border-transparent ${palette} ${className ?? ""}`}
      {...rest}
    >
      {status}
    </Badge>
  );
}
