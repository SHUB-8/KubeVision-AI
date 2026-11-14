/**
 * Which ordinal step identifies a service, shared by every trace view.
 *
 * The design system allows one accent hue plus status colours, so service
 * identity is a *position in a single-hue ramp* rather than a categorical
 * palette. Both the waterfall and the flame graph ask this function, so a
 * service keeps the same shade when you switch between the two layouts.
 *
 * Returns 0 when there is no service name (callers render a neutral step),
 * otherwise 1..8 — the index of a `--color-seq-*` token.
 */
const STEP_COUNT = 8;

export function serviceStep(name: string): number {
  if (!name) return 0;
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash |= 0;
  }
  return (Math.abs(hash) % STEP_COUNT) + 1;
}
