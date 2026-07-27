interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export function normalizeHex(value: string, fallback: string): string {
  return parseHex(value) ? value.trim().toLowerCase() : fallback;
}

export function isCompilerHex(value: string): boolean {
  return parseHex(value) !== undefined;
}

export function mixHex(left: string, right: string, rightWeight: number): string {
  const a = parseHex(left);
  const b = parseHex(right);
  if (!a || !b) throw new Error("Compiler colors must be six-digit hex values.");
  const weight = Math.max(0, Math.min(1, rightWeight));
  return toHex({
    r: Math.round(a.r * (1 - weight) + b.r * weight),
    g: Math.round(a.g * (1 - weight) + b.g * weight),
    b: Math.round(a.b * (1 - weight) + b.b * weight),
  });
}

export function contrastRatio(left: string, right: string): number {
  const a = parseHex(left);
  const b = parseHex(right);
  if (!a || !b) return 0;
  const high = Math.max(luminance(a), luminance(b));
  const low = Math.min(luminance(a), luminance(b));
  return (high + 0.05) / (low + 0.05);
}

export function bestForeground(background: string): "#111315" | "#ffffff" {
  return contrastRatio("#ffffff", background) >= contrastRatio("#111315", background)
    ? "#ffffff"
    : "#111315";
}

export function ensureContrast(
  foreground: string,
  background: string,
  minimum: number,
  preferredTarget: "#000000" | "#ffffff",
): string {
  if (contrastRatio(foreground, background) >= minimum) return foreground;
  for (let step = 1; step <= 12; step += 1) {
    const candidate = mixHex(foreground, preferredTarget, step / 12);
    if (contrastRatio(candidate, background) >= minimum) return candidate;
  }
  return preferredTarget;
}

function parseHex(value: string): RgbColor | undefined {
  const normalized = value.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/u.test(normalized)) return undefined;
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function toHex(color: RgbColor): string {
  return `#${[color.r, color.g, color.b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function luminance(color: RgbColor): number {
  const [red, green, blue] = [color.r, color.g, color.b].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
