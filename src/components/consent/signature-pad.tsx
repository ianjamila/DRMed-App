"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export function SignaturePad({
  onSave,
  saving,
}: {
  onSave: (pngDataUrl: string) => void;
  saving: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [dirty, setDirty] = useState(false);

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    // The canvas is displayed via `w-full`, so its on-screen size (r.width/
    // r.height) differs from its fixed drawing buffer (c.width/c.height).
    // Scale the pointer coords into buffer space so the stroke lands under the
    // pen regardless of how wide the canvas renders.
    return {
      x: (e.clientX - r.left) * (c.width / r.width),
      y: (e.clientY - r.top) * (c.height / r.height),
    };
  }
  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = true;
    const { x, y } = pos(e);
    const ctx = canvasRef.current!.getContext("2d")!;
    ctx.beginPath();
    ctx.moveTo(x, y);
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const { x, y } = pos(e);
    const ctx = canvasRef.current!.getContext("2d")!;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#1a2537";
    ctx.lineTo(x, y);
    ctx.stroke();
    setDirty(true);
  }
  function up() {
    drawing.current = false;
  }
  function clear() {
    const c = canvasRef.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    setDirty(false);
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={520}
        height={140}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
        className="w-full touch-none rounded-lg border-2 border-dashed border-[color:var(--color-brand-steel)] bg-white"
      />
      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={clear}
          disabled={saving}
        >
          Clear
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || saving}
          className="bg-[color:var(--color-brand-cyan)] text-white"
          onClick={() => onSave(canvasRef.current!.toDataURL("image/png"))}
        >
          {saving ? "Saving…" : "Save signature"}
        </Button>
      </div>
    </div>
  );
}
