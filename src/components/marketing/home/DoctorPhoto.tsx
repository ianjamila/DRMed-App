"use client";

import Image from "next/image";
import { useState } from "react";
import { physicianInitials } from "@/lib/physicians/initials";

interface DoctorPhotoProps {
  photoUrl: string;
  name: string;
}

/**
 * Fills its parent frame with the doctor photo (fill + object-cover object-top).
 * On load error, falls back to a centred initials block on warm-sand.
 * Applies group-hover:scale-105 for the card hover zoom effect.
 */
export function DoctorPhoto({ photoUrl, name }: DoctorPhotoProps) {
  const [errored, setErrored] = useState(false);

  if (errored) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[color:var(--color-warm-sand)]">
        <span className="font-[family-name:var(--font-display)] text-3xl text-[color:var(--color-brand-navy)]">
          {physicianInitials(name)}
        </span>
      </div>
    );
  }

  return (
    <Image
      src={photoUrl}
      alt={name}
      fill
      sizes="(min-width: 1020px) 16vw, 33vw"
      className="object-cover object-top transition-transform duration-500 group-hover:scale-105"
      onError={() => setErrored(true)}
      unoptimized={!photoUrl.startsWith("/")}
    />
  );
}
