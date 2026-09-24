"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const FIRST_YEAR = 2023; // clinic data starts Dec 2023

function lastDayOfYear(year: number): string {
  return `${year}-12-31`;
}

/**
 * Date range controls for the operational report: quick-view pills
 * (This month / This year / Last year), a jump-to-year selector, and a
 * custom from/to range. Client component so selections navigate instantly;
 * the page reads the resulting `from`/`to` search params server-side.
 *
 * Pass `basePath` to control the navigation target (defaults to
 * `/staff/admin/operations` for the daily report).
 */
export function DateControls({
  from,
  to,
  today,
  basePath = "/staff/admin/operations",
}: {
  from: string;
  to: string;
  today: string;
  basePath?: string;
}) {
  const router = useRouter();
  const [customFrom, setCustomFrom] = useState(from);
  const [customTo, setCustomTo] = useState(to);

  const go = (f: string, t: string) =>
    router.push(`${basePath}?from=${f}&to=${t}`);

  const year = Number(today.slice(0, 4));
  const monthStart = `${today.slice(0, 7)}-01`;

  const presets = [
    { label: "This month", from: monthStart, to: today },
    { label: "This year", from: `${year}-01-01`, to: today },
    {
      label: "Last year",
      from: `${year - 1}-01-01`,
      to: lastDayOfYear(year - 1),
    },
  ];
  const activePreset = presets.find((p) => p.from === from && p.to === to);

  const years: number[] = [];
  for (let y = year; y >= FIRST_YEAR; y--) years.push(y);

  return (
    <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-3">
      {/* Quick-view pills */}
      <div className="flex flex-col gap-1">
        <Label className="text-xs text-[color:var(--color-brand-text-soft)]">
          Quick views
        </Label>
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => {
            const active = activePreset?.label === p.label;
            return (
              <button
                key={p.label}
                type="button"
                onClick={() => go(p.from, p.to)}
                aria-pressed={active}
                className={cn(
                  buttonVariants({
                    variant: active ? "brand" : "outline",
                    size: "sm",
                  }),
                  "rounded-full",
                )}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Jump-to-year selector */}
      <div className="flex flex-col gap-1">
        <Label className="text-xs text-[color:var(--color-brand-text-soft)]">
          Jump to year
        </Label>
        <Select
          value={activePreset ? "" : from.slice(0, 4)}
          onValueChange={(v) => {
            const yy = Number(v);
            go(`${yy}-01-01`, yy === year ? today : lastDayOfYear(yy));
          }}
        >
          <SelectTrigger size="sm" className="w-28">
            <SelectValue placeholder="Year" />
          </SelectTrigger>
          <SelectContent>
            {years.map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Custom range */}
      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label
            htmlFor="ops-from"
            className="text-xs text-[color:var(--color-brand-text-soft)]"
          >
            From
          </Label>
          <Input
            id="ops-from"
            type="date"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="h-9 w-auto"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label
            htmlFor="ops-to"
            className="text-xs text-[color:var(--color-brand-text-soft)]"
          >
            To
          </Label>
          <Input
            id="ops-to"
            type="date"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            className="h-9 w-auto"
          />
        </div>
        <Button
          type="button"
          variant="brand"
          size="sm"
          className="h-9"
          onClick={() => go(customFrom, customTo)}
        >
          Apply
        </Button>
      </div>
    </div>
  );
}
