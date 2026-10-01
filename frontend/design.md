# Design — KubeVision AI Dashboard

A locked design system for the frontend. Every page/view reads this file before
emitting code. Do not regenerate per view — extend or amend this file when the
system needs to grow.

## Genre
modern-minimal (utilitarian control room — density over decoration)

## Macrostructure family
- App pages (all 7 views): **Workbench** — persistent sidebar + top status bar +
  dense content canvas. Views vary only in the canvas body (graph / table /
  waterfall / log stream / forms).

## Theme
One accent. Status colors are semantic only (never decorative). No gradients,
no glass, no glow.

- `--color-paper`    oklch(0.15 0.025 250)    page background (deep navy cast)
- `--color-paper-2`  oklch(0.185 0.03 250)    raised surface (cards, panels)
- `--color-paper-3`  oklch(0.215 0.032 250)   hover / active surface
- `--color-ink`      oklch(0.93 0.008 250)    primary text
- `--color-ink-2`    oklch(0.62 0.02 250)     secondary text, labels
- `--color-ink-3`    oklch(0.5 0.025 250)     muted / disabled
- `--color-rule`     oklch(0.25 0.033 250)    hairline borders
- `--color-accent`   oklch(0.72 0.11 215)     cyan — interactive + focus only (≤5% of viewport)
- `--color-accent-ink` oklch(0.15 0.02 230)   text on accent fill
- `--color-ok`       oklch(0.72 0.15 155)     healthy status only
- `--color-warn`     oklch(0.78 0.14 80)      warning status only
- `--color-crit`     oklch(0.63 0.2 25)       critical status only
- `--color-focus`    oklch(0.8 0.1 215)       focus ring

Tailwind mapping: the `slate-*` scale in `@theme` IS the neutral ramp above
(slate-950=paper, slate-900=paper-2, slate-800=rule, slate-400=ink-2,
slate-200/100=ink) and `cyan-*` is the accent ramp. Existing utilities
(`bg-slate-900`, `text-slate-400`, `border-slate-800`) therefore resolve to
tokens; new code may use either the semantic name or the scale utility.

## Typography
- Display/UI: IBM Plex Sans, weights 400/500/600 (600 = headings, normal style)
- Mono (all data: numbers, IDs, labels, log lines): IBM Plex Mono, 400/500
- Self-hosted via @fontsource. System stack is the fallback only.
- Base size 13px; table rows 12–13px; page titles 16px semibold (no display
  flourishes — a dashboard's hierarchy comes from weight and case, not size).
- Data columns and metric values are ALWAYS mono. Uppercase 10px mono for
  column headers/labels with +0.08em tracking.

## Spacing
Tailwind default scale (1 unit = 4px). Cards pad 12–16px, rows 8–10px,
sections separated by 24px + a hairline rule. No nested padding surprises:
a card inside a card is a smell.

## Radius
- 6px (`rounded-md`) for cards, inputs, buttons
- 4px (`rounded-sm`) for chips, badges, code
- Nothing larger. No pill radii on rectangles.

## Motion
- Stance: motion-cut. No entrance animations, no pulses except the single
  live-status dot. Data updates crossfade opacity 150ms.
- `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`; durations 120–150ms.
- `prefers-reduced-motion: reduce` → opacity-only, ≤150ms.

## Microinteractions stance
- Silent success (no celebratory toasts). Copy feedback = transient icon swap.
- Hover tooltips delayed 800ms; focus tooltips 0ms.
- Every interactive element: default / hover / focus-visible / active /
  disabled / loading / error / success states. Focus ring 2px `--color-focus`,
  never animated, ≥3:1 contrast.

## CTA voice
- Primary: accent fill, 6px radius, 13px medium — one per view.
- Secondary: 1px rule border on paper-2, no fill.
- Destructive/running states use status colors, never purple/violet.

## Honesty rules (project-specific, non-negotiable)
- Never render "0 / 0 ms / 0%" when the truth is "no data" — use the em dash
  or "no data" with the eBPF-coverage tooltip.
- Simulated/demo data (LangGraph RCA samples) must carry a visible
  "simulated" badge and must never mix into live KPI counts.
- Fabricated rates on inferred topology links are forbidden; label them
  "static map" and surface a banner.

## What views MUST share
- Sidebar + status bar chrome, accent placement, type pairing, CTA voice,
  table row rhythm, status color semantics.

## What views MAY differ on
- Canvas body: graph (React Flow), table, waterfall, log stream, forms.

## Exports

### tokens.css
```css
:root {
  --color-paper:      oklch(0.15 0.025 250);
  --color-paper-2:    oklch(0.185 0.03 250);
  --color-paper-3:    oklch(0.215 0.032 250);
  --color-ink:        oklch(0.93 0.008 250);
  --color-ink-2:      oklch(0.62 0.02 250);
  --color-ink-3:      oklch(0.5 0.025 250);
  --color-rule:       oklch(0.25 0.033 250);
  --color-accent:     oklch(0.72 0.11 215);
  --color-accent-ink: oklch(0.15 0.02 230);
  --color-ok:         oklch(0.72 0.15 155);
  --color-warn:       oklch(0.78 0.14 80);
  --color-crit:       oklch(0.63 0.2 25);
  --color-focus:      oklch(0.8 0.1 215);

  --font-display: "IBM Plex Sans", system-ui, sans-serif;
  --font-body:    "IBM Plex Sans", system-ui, sans-serif;
  --font-mono:    "IBM Plex Mono", ui-monospace, monospace;

  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-short: 150ms;

  --radius-card: 6px;
  --radius-chip: 4px;
}
```
