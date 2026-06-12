import * as React from "react";

export interface DoctorCardProps {
  /** Headshot URL — shown in a fixed 3:4 frame, top-cropped. */
  photo?: string;
  /** Physician name. */
  name: string;
  /** Specialty tag (cyan uppercase), e.g. "Internal Medicine". */
  specialty?: string;
  /** Optional second line (schedule, credentials). */
  subtitle?: string;
  className?: string;
  style?: React.CSSProperties;
}

/** Physician card: 3:4 headshot, specialty tag, and name. */
export function DoctorCard(props: DoctorCardProps): React.ReactElement;
