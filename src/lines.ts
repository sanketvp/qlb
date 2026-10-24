/*
 * Ported from claude-swap 0.28.0.
 * Upstream file(s): src/claude_swap/lines.py:39-64,88-126.
 * License: MIT.
 * Modified for QLB. See NOTICE.
 */

/** One relevant usage window: label, used percentage, and optional reset time. */
export type UsageWindow = readonly [label: string, pct: number, resetsAt: string | null | undefined];

/** The window that holds an account back under the configured switch lines. */
export interface BindingWindow {
  label: string;
  pct: number;
  line: number;
  resetsAt: string | null | undefined;
  lineHeadroom: number;
  over: boolean;
}

/** The switch line for a window; only the 5h window ignores a weekly line. */
export function windowLine(label: string, threshold: number, weeklyThreshold?: number): number {
  return weeklyThreshold === undefined || label === '5h' ? threshold : weeklyThreshold;
}

/**
 * Policy headroom on the shared 5h-scale ruler. Equal lines deliberately use
 * raw headroom so the default configuration is bit-identical to max-pct.
 */
export function lineHeadroom(pct: number, line: number, threshold: number): number {
  if (line === threshold) return 100 - pct;
  if (pct <= line) return (100 - threshold) + (threshold * (line - pct)) / line;
  return ((100 - threshold) * (100 - pct)) / (100 - line);
}

/** Optional common ruler for comparing accounts whose effective lines differ. */
export interface BindingWindowOptions {
  scale?: number;
}

/**
 * Return the least-policy-headroom window, prioritizing an over-line window.
 * Equal keys retain input order, matching Python's strict-less-than selection.
 */
export function bindingWindow(
  windows: Iterable<UsageWindow>,
  threshold: number,
  weeklyThreshold?: number,
  options: BindingWindowOptions = {},
): BindingWindow | undefined {
  const ruler = options.scale ?? threshold;
  let best: BindingWindow | undefined;

  for (const [label, pct, resetsAt] of windows) {
    const line = windowLine(label, threshold, weeklyThreshold);
    const candidate: BindingWindow = {
      label,
      pct,
      line,
      resetsAt,
      lineHeadroom: lineHeadroom(pct, line, ruler),
      over: pct >= line,
    };

    if (
      best === undefined ||
      (best.over === candidate.over
        ? candidate.lineHeadroom < best.lineHeadroom
        : candidate.over)
    ) {
      best = candidate;
    }
  }

  return best;
}
