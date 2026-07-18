export type CuaDriverTelemetryLevel = "debug" | "info" | "warn" | "error";

export interface CuaDriverTelemetryEvent {
  readonly at: string;
  readonly level: CuaDriverTelemetryLevel;
  readonly event: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface CuaDriverTelemetrySink {
  emit(level: CuaDriverTelemetryLevel, event: string, details?: Readonly<Record<string, unknown>>): void;
  snapshot(): readonly CuaDriverTelemetryEvent[];
  clear(): void;
}

export interface CuaDriverTelemetryOptions {
  readonly maxEvents?: number;
  readonly clock?: () => Date;
  readonly onEvent?: (event: CuaDriverTelemetryEvent) => void;
}

const DEFAULT_MAX_EVENTS = 256;
const MAX_EVENT_NAME_LENGTH = 120;
const MAX_DETAIL_KEY_LENGTH = 80;
const MAX_DETAIL_VALUE_LENGTH = 512;
const SENSITIVE_KEY = /(token|secret|password|credential|nonce|authorization|cookie|api.?key|private.?key)/iu;

/** Bounded, in-memory diagnostics. Secrets, nonces and protocol content never leave this boundary. */
export function createCuaDriverTelemetry(options: CuaDriverTelemetryOptions = {}): CuaDriverTelemetrySink {
  const maxEvents = Number.isSafeInteger(options.maxEvents) && (options.maxEvents ?? 0) > 0
    ? Math.min(options.maxEvents!, 2048)
    : DEFAULT_MAX_EVENTS;
  const clock = options.clock ?? (() => new Date());
  const events: CuaDriverTelemetryEvent[] = [];
  return {
    emit(level, event, details = {}) {
      const safeEvent: CuaDriverTelemetryEvent = {
        at: safeIso(clock),
        level,
        event: normalizeText(event, MAX_EVENT_NAME_LENGTH),
        details: sanitizeDetails(details),
      };
      Object.freeze(safeEvent);
      events.push(safeEvent);
      while (events.length > maxEvents) {
        events.shift();
      }
      try {
        options.onEvent?.(safeEvent);
      } catch {
        // Telemetry is observational and cannot break lifecycle cleanup.
      }
    },
    snapshot() {
      return events.slice();
    },
    clear() {
      events.length = 0;
    },
  };
}

export function redactCuaDriverDiagnostic(value: unknown): string {
  if (typeof value !== "string") {
    return "[redacted]";
  }
  return value
    .replaceAll(/(bearer\s+)[^\s,;]+/giu, "$1[redacted]")
    .replaceAll(/(token|secret|password|nonce|api[_-]?key)\s*[=:]\s*[^\s,;]+/giu, "$1=[redacted]")
    .slice(0, MAX_DETAIL_VALUE_LENGTH);
}

function sanitizeDetails(details: Readonly<Record<string, unknown>>): Readonly<Record<string, string | number | boolean | null>> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [rawKey, rawValue] of Object.entries(details)) {
    const key = normalizeText(rawKey, MAX_DETAIL_KEY_LENGTH);
    if (!key || SENSITIVE_KEY.test(key)) {
      continue;
    }
    if (typeof rawValue === "string") {
      result[key] = redactCuaDriverDiagnostic(rawValue);
    } else if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      result[key] = rawValue;
    } else if (typeof rawValue === "boolean" || rawValue === null) {
      result[key] = rawValue;
    } else {
      result[key] = redactCuaDriverDiagnostic(String(rawValue));
    }
  }
  return Object.freeze(result);
}

function normalizeText(value: string, maxLength: number): string {
  return value.replaceAll(/[\u0000-\u001f\u007f]/gu, "?").trim().slice(0, maxLength);
}

function safeIso(clock: () => Date): string {
  try {
    const value = clock();
    return Number.isFinite(value.getTime()) ? value.toISOString() : new Date(0).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}
