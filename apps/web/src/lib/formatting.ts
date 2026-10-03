export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Compact elapsed time for conversation chrome; absent/invalid facts stay absent. */
export function formatElapsedDuration(durationMs: number | undefined, locale: string): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  let seconds = Math.floor(durationMs / 1_000);
  const parts: string[] = [];
  for (const [unit, divisor] of [["hour", 3_600], ["minute", 60], ["second", 1]] as const) {
    const amount = Math.floor(seconds / divisor);
    seconds %= divisor;
    if (amount === 0 && (unit !== "second" || parts.length > 0)) continue;
    parts.push(new Intl.NumberFormat(locale, {
      style: "unit", unit, unitDisplay: "narrow", maximumFractionDigits: 0,
    }).format(amount));
  }
  return new Intl.ListFormat(locale, { style: "narrow", type: "unit" }).format(parts);
}

export function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/)[0] ?? "";
  return firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine || "Untitled task";
}
