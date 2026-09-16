"use client";

import { Tooltip as Primitive } from "@base-ui/react/tooltip";
import { useId, useRef, useState } from "react";

/** A separate help control keeps tapping a navigation link immediate. */
export function Tooltip({ content, label, descriptionId }: {
  content: string;
  label: string;
  descriptionId: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerId = useId();
  const tooltipId = useId();
  const openOnPress = useRef(false);
  return (
    <>
      <span id={descriptionId} className="sr-only">{content}</span>
      <Primitive.Root open={open} onOpenChange={setOpen} triggerId={triggerId}>
        <Primitive.Trigger
          id={triggerId}
          type="button"
          delay={150}
          closeOnClick={false}
          aria-label={label}
          aria-describedby={open ? tooltipId : descriptionId}
          onPointerDown={() => { openOnPress.current = open; }}
          onClick={(event) => setOpen(event.detail === 0 ? !open : !openOnPress.current)}
          className="absolute right-0 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md text-current opacity-75 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-[color:var(--color-brand-cyan)]"
        >
          <span aria-hidden="true" className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-current text-[10px] font-bold">i</span>
        </Primitive.Trigger>
        <Primitive.Portal>
          <Primitive.Positioner side="right" sideOffset={8} className="z-[100]">
            <Primitive.Popup id={tooltipId} role="tooltip" className="max-w-64 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-2 text-sm text-white shadow-lg">
              {content}
            </Primitive.Popup>
          </Primitive.Positioner>
        </Primitive.Portal>
      </Primitive.Root>
    </>
  );
}
