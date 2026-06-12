/**
 * Marketing motion primitives (June 2026 redesign).
 *
 * Shared guardrails across all of these: transform/opacity only, every ambient
 * animation gated on prefers-reduced-motion, ambient cycles ≥8s, ambient
 * simplified to static below 640px, at most two ambient layers per section.
 */
export { Reveal } from "./Reveal";
export { HeroStagger, HeroStaggerItem } from "./HeroStagger";
export { CountUp } from "./CountUp";
export { EcgDivider } from "./EcgDivider";
export { EcgUnderline } from "./EcgUnderline";
export { ScrollPulse } from "./ScrollPulse";
export { AmbientGlow } from "./AmbientGlow";
export { PendingPhoto } from "./PendingPhoto";
