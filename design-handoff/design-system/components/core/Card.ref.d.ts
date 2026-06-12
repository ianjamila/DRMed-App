import * as React from "react";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Lift with a soft shadow on hover (use for clickable cards). */
  interactive?: boolean;
  /** Inner padding in px. @default 24 */
  padding?: number;
  children?: React.ReactNode;
}

/**
 * White content container with the signature 1px hairline ring and 14px
 * radius. Compose with CardTitle / CardDescription / CardFooter.
 */
export function Card(props: CardProps): React.ReactElement;
export function CardTitle(props: React.HTMLAttributes<HTMLHeadingElement>): React.ReactElement;
export function CardDescription(props: React.HTMLAttributes<HTMLParagraphElement>): React.ReactElement;
export function CardFooter(props: React.HTMLAttributes<HTMLDivElement>): React.ReactElement;
