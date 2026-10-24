//! Validation and clamping for the Presenter -> shell layout protocol.
//!
//! Presenter messages cross an opaque iframe boundary, so TypeScript types are
//! never treated as runtime guarantees. The host accepts only finite,
//! bounded values and keeps the window inside the current work area later in
//! the sizer.

import type { PageLayoutReport } from "./contracts";

export const MIN_LAYOUT_HEIGHT = 1;
export const MAX_LAYOUT_HEIGHT = 10_000;
export const MAX_LAYOUT_WIDTH = 10_000;

function boundedNumber(
  value: unknown,
  path: string,
  min: number,
  max: number
): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  if (value < min || value > max) {
    throw new Error(`${path} must be between ${min} and ${max}`);
  }
  return Math.round(value);
}

/** Validate one Presenter layout report. Unknown sizing modes, non-finite
 * numbers, negative heights and unbounded values fail closed. */
export function normalizeLayoutReport(report: unknown): PageLayoutReport {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("layout report must be an object");
  }
  const value = report as Record<string, unknown>;
  if (value.sizing !== "fit" && value.sizing !== "fixed") {
    throw new Error('layout sizing must be "fit" or "fixed"');
  }
  if (value.expanded != null && typeof value.expanded !== "boolean") {
    throw new Error("layout expanded must be a boolean");
  }
  const contentHeight = boundedNumber(
    value.contentHeight,
    "layout contentHeight",
    MIN_LAYOUT_HEIGHT,
    MAX_LAYOUT_HEIGHT
  );
  const height = boundedNumber(
    value.height,
    "layout height",
    MIN_LAYOUT_HEIGHT,
    MAX_LAYOUT_HEIGHT
  );
  return {
    sizing: value.sizing,
    ...(contentHeight !== undefined ? { contentHeight } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(value.expanded !== undefined ? { expanded: value.expanded as boolean } : {}),
  };
}

/** Validate the optional axes of `lume.app.resize`. Omitted axes stay
 * unchanged; supplied axes must be finite and bounded. */
export function normalizeResizeRequest(
  width: unknown,
  height: unknown
): { width?: number; height?: number } {
  const w = boundedNumber(width, "resize width", 1, MAX_LAYOUT_WIDTH);
  const h = boundedNumber(height, "resize height", MIN_LAYOUT_HEIGHT, MAX_LAYOUT_HEIGHT);
  return {
    ...(w !== undefined ? { width: w } : {}),
    ...(h !== undefined ? { height: h } : {}),
  };
}
