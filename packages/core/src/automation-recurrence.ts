import type { AutomationDefinition, AutomationSchedule } from "./automation-types.js";

const DAY_MS = 86_400_000;
const DATE_LIMIT_MS = 8_640_000_000_000_000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const RULE_FIELDS = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYHOUR", "BYMINUTE", "BYSECOND", "WKST", "COUNT", "UNTIL"]);

interface ParsedRRule {
  readonly freq: "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";
  readonly interval: number;
  readonly weekStart: number;
  readonly byDay: readonly number[];
  readonly byMonthDay: readonly number[];
  readonly byHour: readonly number[];
  readonly byMinute: readonly number[];
  readonly bySecond: readonly number[];
  readonly count?: number;
  readonly until?: number;
}

/** A recurrence calculation failure, distinct from scheduler persistence failures. */
export class AutomationRecurrenceError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "AutomationRecurrenceError";
  }
}

/** A valid finite rule has no future occurrence; the scheduler disables it. */
export class AutomationRecurrenceCompleteError extends AutomationRecurrenceError {}

/** Reject unsupported fields instead of widening a finite or malformed rule. */
export function isSupportedAutomationRRule(rule: string): boolean {
  return parseRRule(rule) !== undefined;
}

export function computeNextAutomationRunAt(
  automation: Pick<AutomationDefinition, "trigger" | "rrule" | "createdAt">,
  from: Date = new Date(),
): string {
  try {
    if (automation.trigger.type !== "schedule") {
      return new Date(from.getTime() + DAY_MS).toISOString();
    }
    // Millisecond intervals are a separate contract, not rounded MINUTELY rules.
    if (automation.trigger.schedule.cadence !== "interval" && automation.rrule) {
      const next = computeNextRunAtFromRRule(automation.rrule, automation.trigger.timezone, from, new Date(automation.createdAt));
      if (!next) {
        if (isSupportedAutomationRRule(automation.rrule) && /(?:COUNT=1|UNTIL=)/i.test(automation.rrule)) {
          throw new AutomationRecurrenceCompleteError("Automation recurrence has no future occurrence.");
        }
        throw new AutomationRecurrenceError("Automation recurrence RRULE is unsupported, invalid, or has no representable next occurrence.");
      }
      return next;
    }
    return computeNextRunAt(automation.trigger.schedule, automation.trigger.timezone, from);
  } catch (error) {
    if (error instanceof AutomationRecurrenceError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AutomationRecurrenceError(`Automation recurrence calculation failed: ${message}`, error);
  }
}

/** Validate only authored scheduled recurrence, without touching persistence. */
export function assertAutomationRecurrence(
  automation: Pick<AutomationDefinition, "trigger" | "rrule" | "createdAt">,
  from: Date = new Date(),
): void {
  if (automation.trigger.type === "schedule") computeNextAutomationRunAt(automation, from);
}

export function computeNextRunAt(schedule: AutomationSchedule, timezone: string, from: Date = new Date()): string {
  if (schedule.cadence === "interval") {
    return new Date(from.getTime() + schedule.everyMs).toISOString();
  }
  const [hour, minute] = schedule.timeOfDay.split(":").map(Number);
  const zone = zonedCalendar(timezone);
  const firstDay = dayNumber(zone.parts(from));
  for (let offset = 0; offset <= 8; offset += 1) {
    const day = firstDay + offset;
    if (schedule.cadence === "weekly" && weekday(day) !== schedule.weekday) continue;
    const candidate = zone.instant(day, hour!, minute!, 0);
    if (candidate && candidate.getTime() > from.getTime()) return candidate.toISOString();
  }
  throw new Error("Automation recurrence schedule has no representable next occurrence.");
}

/**
 * Query the next occurrence strictly after `from`, using an immutable start.
 * Production supplies persisted createdAt. The optional start only preserves
 * the old interval-one pure helper API; interval>1 requires an explicit anchor.
 */
export function computeNextRunAtFromRRule(
  rule: string, timezone: string, from: Date = new Date(), anchor?: Date,
): string | undefined {
  const parsed = parseRRule(rule);
  if (!parsed || !Number.isFinite(from.getTime()) || (!anchor && parsed.interval > 1)) return undefined;
  const start = anchor ?? from;
  if (!Number.isFinite(start.getTime())) return undefined;
  return computeNextRunAtFromParsed(parsed, timezone, from, start);
}

function computeNextRunAtFromParsed(parsed: ParsedRRule, timezone: string, from: Date, start: Date): string | undefined {
  if (parsed.freq === "MINUTELY" || parsed.freq === "HOURLY") {
    const period = parsed.interval * (parsed.freq === "HOURLY" ? 3_600_000 : 60_000);
    const index = Math.max(0, Math.floor((from.getTime() - start.getTime()) / period) + 1);
    const next = new Date(start.getTime() + index * period);
    if (!Number.isFinite(next.getTime()) || (parsed.until !== undefined && next.getTime() > parsed.until)) return undefined;
    if (parsed.count === 1 && from.getTime() >= start.getTime()) return undefined;
    return next.toISOString();
  }
  if (parsed.count === 1) {
    const first = computeNextRunAtFromParsed({ ...parsed, count: undefined }, timezone, new Date(start.getTime() - 1), start);
    if (!first || from.getTime() >= Date.parse(first)) return undefined;
  }
  const zone = zonedCalendar(timezone);
  const startParts = zone.parts(start);
  const startDay = dayNumber(startParts);
  const queryParts = zone.parts(from);
  const queryDay = dayNumber(queryParts);
  const hours = parsed.byHour.length ? parsed.byHour : [startParts.hour];
  const minutes = parsed.byMinute.length ? parsed.byMinute : [startParts.minute];
  const seconds = parsed.bySecond.length ? parsed.bySecond : [startParts.second];
  const step = parsed.interval * (parsed.freq === "WEEKLY" ? 7 : 1);
  const firstPeriod = parsed.freq === "WEEKLY"
    ? startDay - positiveModulo(weekday(startDay) - parsed.weekStart, 7)
    : startDay;
  const startMonth = startParts.year * 12 + startParts.month - 1;
  const queryMonth = queryParts.year * 12 + queryParts.month - 1;
  const firstMonth = startMonth;
  let periodIndex = parsed.freq === "MONTHLY"
    ? Math.max(0, Math.floor((queryMonth - firstMonth) / parsed.interval))
    : Math.max(0, Math.floor((queryDay - firstPeriod) / step));
  const days = parsed.freq === "WEEKLY"
    ? (parsed.byDay.length ? parsed.byDay : [weekday(startDay)])
      .map((day) => positiveModulo(day - parsed.weekStart, 7)).sort((a, b) => a - b)
    : [0];

  // Jump whole recurrence periods, not a fixed 370-day lookahead. The finite
  // search guard fails closed (never falls back to an unrelated daily trigger).
  for (let attempt = 0; attempt < 370; attempt += 1, periodIndex += 1) {
    const monthlyDays = parsed.freq === "MONTHLY"
      ? (parsed.byMonthDay.length ? parsed.byMonthDay : [startParts.day])
      : [undefined];
    for (const offset of parsed.freq === "MONTHLY" ? monthlyDays : days) {
      let day: number;
      if (parsed.freq === "MONTHLY") {
        const monthIndex = firstMonth + periodIndex * parsed.interval;
        const year = Math.floor(monthIndex / 12);
        const month = positiveModulo(monthIndex, 12) + 1;
        const monthDay = offset as number;
        if (monthDay > daysInMonth(year, month)) continue;
        day = dayNumber({ year, month, day: monthDay, hour: 0, minute: 0, second: 0 });
      } else {
        day = firstPeriod + periodIndex * step + (offset as number);
      }
      if (day < startDay || day < queryDay) continue;
      if (parsed.freq === "DAILY" && parsed.byDay.length && !parsed.byDay.includes(weekday(day))) continue;
      if (!Number.isFinite(new Date(day * DAY_MS).getTime())) return undefined;
      // Only first-fold occurrences are eligible. Elapsed local times cannot
      // become a later second-fold occurrence; prune them before Intl work.
      const lowerSecond = Math.max(day === startDay ? timeOfDaySecond(startParts) : 0,
        day === queryDay ? timeOfDaySecond(queryParts) : 0);
      const validIntervals = zone.eligibleIntervals(day, lowerSecond, Math.max(from.getTime() + 1, start.getTime()));
      const hasValidWallTime = (begin: number, end: number) => validIntervals.some((interval) =>
        Math.max(begin, lowerSecond, interval.start) < Math.min(end, interval.end));
      if (!hasValidWallTime(lowerSecond, 86_400)) continue;
      for (const hour of hours) {
        if (!hasValidWallTime(hour * 3600, (hour + 1) * 3600)) continue;
        for (const minute of minutes) {
          const minuteStart = hour * 3600 + minute * 60;
          if (!hasValidWallTime(minuteStart, minuteStart + 60)) continue;
          for (const second of seconds) {
            if (!hasValidWallTime(minuteStart + second, minuteStart + second + 1)) continue;
            const candidate = zone.instant(day, hour, minute, second);
            if (candidate && candidate.getTime() >= start.getTime() && candidate.getTime() > from.getTime()
              && (parsed.until === undefined || candidate.getTime() <= parsed.until)
              && (parsed.count !== 1 || candidate.getTime() === firstCalendarOccurrence(parsed, timezone, start))) {
              return candidate.toISOString();
            }
          }
        }
      }
    }
  }
  return undefined;
}

function parseRRule(rule: string): ParsedRRule | undefined {
  const fields = new Map<string, string>();
  for (const part of rule.trim().replace(/^RRULE:/i, "").split(";")) {
    const match = /^([A-Z]+)=([^=]+)$/i.exec(part.trim());
    if (!match) return undefined;
    const key = match[1]!.toUpperCase();
    if (!RULE_FIELDS.has(key) || fields.has(key)) return undefined;
    fields.set(key, match[2]!.trim().toUpperCase());
  }
  const freq = fields.get("FREQ");
  if (freq !== "MINUTELY" && freq !== "HOURLY" && freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY") return undefined;
  const interval = fields.has("INTERVAL") ? positiveInteger(fields.get("INTERVAL")!) : 1;
  if (interval === undefined) return undefined;
  const weekStart = fields.has("WKST") ? WEEKDAYS.indexOf(fields.get("WKST") as typeof WEEKDAYS[number]) : 1;
  if (weekStart < 0) return undefined;
  const byDay = fields.has("BYDAY") ? weekdays(fields.get("BYDAY")!) : [];
  const byMonthDay = fields.has("BYMONTHDAY") ? monthDays(fields.get("BYMONTHDAY")!) : [];
  const byHour = numbers(fields.get("BYHOUR"), 23);
  const byMinute = numbers(fields.get("BYMINUTE"), 59);
  const bySecond = numbers(fields.get("BYSECOND"), 59);
  if (!byDay || !byMonthDay || !byHour || !byMinute || !bySecond) return undefined;
  // The existing MINUTELY contract is an elapsed-time recurrence. Calendar
  // filters on it were previously ignored; reject them rather than fake support.
  if ((freq === "MINUTELY" || freq === "HOURLY") && ["BYDAY", "BYMONTHDAY", "BYHOUR", "BYMINUTE", "BYSECOND", "WKST"].some((key) => fields.has(key))) return undefined;
  if (freq === "MONTHLY" && fields.has("BYDAY")) return undefined;
  const count = fields.has("COUNT") ? positiveInteger(fields.get("COUNT")!) : undefined;
  if (fields.has("COUNT") && count !== 1) return undefined;
  const until = fields.has("UNTIL") ? parseUntil(fields.get("UNTIL")!) : undefined;
  if (fields.has("UNTIL") && until === undefined) return undefined;
  return { freq, interval, weekStart, byDay, byMonthDay, byHour, byMinute, bySecond, count, until };
}

function positiveInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function numbers(value: string | undefined, max: number): readonly number[] | undefined {
  if (value === undefined) return [];
  const items = value.split(",");
  if (items.some((item) => !/^\d+$/.test(item) || Number(item) > max)) return undefined;
  return [...new Set(items.map(Number))].sort((a, b) => a - b);
}

function weekdays(value: string): readonly number[] | undefined {
  const items = value.split(",").map((day) => WEEKDAYS.indexOf(day as typeof WEEKDAYS[number]));
  return items.includes(-1) ? undefined : [...new Set(items)].sort((a, b) => a - b);
}

function monthDays(value: string): readonly number[] | undefined {
  const items = value.split(",");
  if (items.some((item) => !/^-?\d+$/.test(item) || Number(item) < 1 || Number(item) > 31)) return undefined;
  return [...new Set(items.map(Number))].sort((a, b) => a - b);
}

function parseUntil(value: string): number | undefined {
  const normalized = value.trim();
  if (/^\d{8}T\d{6}Z$/.test(normalized)) {
    const iso = `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}T${normalized.slice(9, 11)}:${normalized.slice(11, 13)}:${normalized.slice(13, 15)}Z`;
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const parsed = Date.parse(normalized);
  return normalized.endsWith("Z") && Number.isFinite(parsed) ? parsed : undefined;
}

function firstCalendarOccurrence(parsed: ParsedRRule, timezone: string, start: Date): number {
  const withoutCount = { ...parsed, count: undefined };
  const first = computeNextRunAtFromParsed(withoutCount, timezone, new Date(start.getTime() - 1), start);
  return first ? Date.parse(first) : Number.NaN;
}

function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCDate();
}

interface ZonedParts { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number; readonly second: number }

function dayNumber(parts: ZonedParts): number {
  return Math.floor(calendarMillis(parts.year, parts.month, parts.day) / DAY_MS);
}

/** Date.UTC treats years 0..99 as 1900..1999; setUTCFullYear preserves the year. */
function calendarMillis(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

function weekday(day: number): number { return positiveModulo(day + 4, 7); }
function positiveModulo(value: number, modulus: number): number { return ((value % modulus) + modulus) % modulus; }
function timeOfDaySecond(parts: ZonedParts): number { return parts.hour * 3600 + parts.minute * 60 + parts.second; }

/** Resolve exact wall times: skip DST gaps and choose only the first fold. */
function zonedCalendar(timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, era: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  function parts(date: Date): ZonedParts {
    const fields: Record<string, number> = {};
    let beforeCommonEra = false;
    for (const part of formatter.formatToParts(date)) {
      if (["year", "month", "day", "hour", "minute", "second"].includes(part.type)) fields[part.type] = Number(part.value);
      if (part.type === "era" && part.value === "BC") beforeCommonEra = true;
    }
    if (beforeCommonEra) fields.year = 1 - fields.year!;
    return fields as unknown as ZonedParts;
  }
  function localMillis(value: ZonedParts): number {
    return calendarMillis(value.year, value.month, value.day, value.hour, value.minute, value.second);
  }
  const offsetCache = new Map<number, number>();
  const dayCache = new Map<number, { readonly offsets: readonly number[]; readonly intervals: readonly WallInterval[] }>();
  function offsetAt(instant: number): number {
    const cached = offsetCache.get(instant);
    if (cached !== undefined) return cached;
    const offset = localMillis(parts(new Date(instant))) - instant;
    offsetCache.set(instant, offset);
    return offset;
  }
  function dayProfile(day: number) {
    const cached = dayCache.get(day);
    if (cached) return cached;
    const wallStart = day * DAY_MS;
    const offsets = new Set<number>();
    const gaps: WallInterval[] = [];
    const samples = [...new Set([-2, -1, 0, 1, 2, 3].map((delta) =>
      Math.max(-DATE_LIMIT_MS, Math.min(DATE_LIMIT_MS, wallStart + delta * DAY_MS))))];
    const probe = (instant: number) => {
      const offset = offsetAt(instant);
      if (Number.isFinite(offset)) offsets.add(offset);
      return offset;
    };
    for (let index = 0; index < samples.length; index += 1) {
      const left = samples[index]!;
      const leftOffset = probe(left);
      const right = samples[index + 1];
      if (right === undefined) break;
      const rightOffset = probe(right);
      if (!Number.isFinite(leftOffset) || !Number.isFinite(rightOffset) || leftOffset === rightOffset) continue;
      let before = left;
      let after = right;
      // Locate the adjacent real seconds around an offset change once per day,
      // rather than probing every nonexistent second in a dense BY* product.
      while (after - before > 1000) {
        const middle = before + Math.floor((after - before) / 2000) * 1000;
        if (probe(middle) === leftOffset) before = middle;
        else after = middle;
      }
      const beforeOffset = probe(after - 1000);
      const afterOffset = probe(after);
      if (afterOffset > beforeOffset) {
        const start = Math.max(0, (after + beforeOffset - wallStart) / 1000);
        const end = Math.min(86_400, (after + afterOffset - wallStart) / 1000);
        if (start < end) gaps.push({ start, end });
      }
    }
    const intervals: WallInterval[] = [];
    let cursor = 0;
    for (const gap of gaps.sort((left, right) => left.start - right.start)) {
      if (cursor < gap.start) intervals.push({ start: cursor, end: gap.start });
      cursor = Math.max(cursor, gap.end);
    }
    if (cursor < 86_400) intervals.push({ start: cursor, end: 86_400 });
    const profile = { offsets: [...offsets], intervals };
    dayCache.set(day, profile);
    return profile;
  }
  function instant(day: number, hour: number, minute: number, second: number): Date | undefined {
    const wallSecond = hour * 3600 + minute * 60 + second;
    const profile = dayProfile(day);
    if (!profile.intervals.some((interval) => interval.start <= wallSecond && wallSecond < interval.end)) return undefined;
    const wall = day * DAY_MS + wallSecond * 1000;
    const candidates: number[] = [];
    // Cached offsets only narrow candidates. Exact roundtrips remain authority,
    // and the minimum instant preserves the existing earlier-fold contract.
    for (const offset of profile.offsets) {
      const candidate = wall - offset;
      if (Number.isFinite(new Date(candidate).getTime()) && localMillis(parts(new Date(candidate))) === wall) candidates.push(candidate);
    }
    return candidates.length ? new Date(Math.min(...candidates)) : undefined;
  }
  function eligibleIntervals(day: number, lowerSecond: number, minimumInstant: number): readonly WallInterval[] {
    const intervals: WallInterval[] = [];
    const resolveSecond = (second: number) => instant(day, Math.floor(second / 3600), Math.floor(second / 60) % 60, second % 60);
    for (const interval of dayProfile(day).intervals) {
      const begin = Math.max(lowerSecond, Math.ceil(interval.start));
      const end = Math.ceil(interval.end);
      if (begin >= end) continue;
      const first = resolveSecond(begin);
      if (!first || first.getTime() >= minimumInstant) {
        intervals.push({ start: begin, end });
        continue;
      }
      const last = resolveSecond(end - 1);
      if (!last) {
        intervals.push({ start: begin, end });
        continue;
      }
      if (last.getTime() < minimumInstant) continue;
      let low = begin;
      let high = end - 1;
      let unresolved = false;
      // The earlier-fold instant is increasing within an exact valid wall
      // interval, including the forward UTC jump at the end of an overlap.
      // Locate its UTC lower bound once, not once for every elapsed BY* second.
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = resolveSecond(middle);
        if (!candidate) {
          unresolved = true;
          break;
        }
        if (candidate.getTime() < minimumInstant) low = middle + 1;
        else high = middle;
      }
      // An undefined probe (including Date range edges) is not evidence that
      // occurrences are elapsed. Keep the original range for exact resolution.
      intervals.push({ start: unresolved ? begin : low, end });
    }
    return intervals;
  }
  return { parts, instant, eligibleIntervals };
}

interface WallInterval { readonly start: number; readonly end: number }
