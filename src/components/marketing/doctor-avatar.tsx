"use client";

import Image from "next/image";
import { useState } from "react";
import { physicianInitials } from "@/lib/physicians/initials";

interface Props {
  photoUrl: string;
  name: string;
}

export function DoctorAvatar({ photoUrl, name }: Props) {
  const [errored, setErrored] = useState(false);

  if (errored) {
    return (
      <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full border-2 border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] font-[family-name:var(--font-heading)] text-xl font-extrabold text-[color:var(--color-brand-cyan)]">
        {physicianInitials(name)}
      </div>
    );
  }

  return (
    <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-full border-2 border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)]">
      <Image
        src={photoUrl}
        alt={name}
        fill
        sizes="80px"
        className="object-cover"
        onError={() => setErrored(true)}
        unoptimized={!photoUrl.startsWith("/")}
      />
    </div>
  );
}
