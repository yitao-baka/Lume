//! Shared color parsing and contrast helpers for skin surfaces and accents.

export type SurfaceTone = "light" | "dark";

function channels(value: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const raw = match[1];
  return [
    Number.parseInt(raw.slice(0, 2), 16),
    Number.parseInt(raw.slice(2, 4), 16),
    Number.parseInt(raw.slice(4, 6), 16),
  ];
}

/** Normalize an untrusted value to `""` or a lowercase `#rrggbb`. */
export function normalizeHexColor(value: unknown): string {
  if (typeof value !== "string") return "";
  let raw = value.trim();
  if (!raw) return "";
  if (raw.startsWith("#")) raw = raw.slice(1);
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    raw = raw
      .split("")
      .map((character) => character + character)
      .join("");
  }
  if (!/^[0-9a-f]{6}$/i.test(raw)) return "";
  return `#${raw.toLowerCase()}`;
}

function luminance(value: string): number {
  const parsed = channels(normalizeHexColor(value));
  if (!parsed) return 0;
  const [red, green, blue] = parsed.map((channel) => {
    const unit = channel / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function mixHex(
  color: string,
  target: string,
  percent: number,
): string {
  const left = channels(normalizeHexColor(color));
  const right = channels(normalizeHexColor(target));
  if (!left || !right) return color;
  const ratio = Math.min(100, Math.max(0, percent)) / 100;
  return `#${left
    .map((channel, index) =>
      Math.round(channel * (1 - ratio) + right[index] * ratio)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Which text palette the surface needs: a dark surface uses light text. */
export function surfaceToneFor(value: string): SurfaceTone {
  const normalized = normalizeHexColor(value);
  if (!normalized) return "dark";
  return contrastRatio("#ffffff", normalized) >= contrastRatio("#000000", normalized)
    ? "dark"
    : "light";
}
