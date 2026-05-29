"use client";

import { QRCodeSVG } from "qrcode.react";
import { cn } from "@/lib/utils";

// Renders the QR locally as vector SVG — no third-party QR service, so no
// privacy leak. Reused in PR2 for the /register link QR.
export function QrCode({ value, size = 160, className }: { value: string; size?: number; className?: string }) {
  return (
    <div className={cn("inline-flex rounded-lg bg-white p-3 ring-1 ring-foreground/10", className)}>
      <QRCodeSVG value={value} size={size} level="M" marginSize={0} />
    </div>
  );
}
