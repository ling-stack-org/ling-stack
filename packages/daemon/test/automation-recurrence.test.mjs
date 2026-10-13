import assert from "node:assert/strict";
import { test } from "node:test";
import { computeNextAutomationRunAt, computeNextRunAtFromRRule } from "../dist/features/automations/scheduler.js";
import { assertAutomationRecurrence, AutomationRecurrenceError } from "../dist/features/automations/recurrence.js";

const anchor = new Date("2026-06-01T09:00:00.000Z");
const cases = [
  ["daily interval2 skips the intervening local day", "FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0;BYSECOND=0", "UTC", "2026-06-03T10:00:00Z", anchor, "2026-06-05T09:00:00.000Z"],
  ["daily interval2 still finds an eligible day from a skipped day", "FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0;BYSECOND=0", "UTC", "2026-06-02T12:00:00Z", anchor, "2026-06-03T09:00:00.000Z"],
  ["weekly interval2 skips the intervening calendar week", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=0;BYSECOND=0", "UTC", "2026-06-04T12:00:00Z", anchor, "2026-06-15T09:00:00.000Z"],
  ["weekly without BYDAY uses the anchor weekday", "FREQ=WEEKLY;INTERVAL=2;BYHOUR=9;BYMINUTE=0;BYSECOND=0", "UTC", "2026-06-02T12:00:00Z", anchor, "2026-06-15T09:00:00.000Z"],
  ["minutely interval2 remains on its anchor after a mid-period query", "FREQ=MINUTELY;INTERVAL=2", "UTC", "2026-06-01T09:01:00Z", anchor, "2026-06-01T09:02:00.000Z"],
  ["recurrence does not skip an occurrence less than one second away", "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0", "UTC", "2026-06-02T08:59:59.500Z", anchor, "2026-06-02T09:00:00.000Z"],
  ["local day interval2 is not a UTC day phase", "FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0;BYSECOND=0", "Asia/Shanghai", "2026-06-03T02:00:00Z", new Date("2026-06-01T01:00:00Z"), "2026-06-05T01:00:00.000Z"],
  ["nonexistent DST local time is skipped rather than shifted", "FREQ=DAILY;BYHOUR=2;BYMINUTE=30;BYSECOND=0", "America/New_York", "2026-03-08T05:00:00Z", new Date("2026-03-07T07:30:00Z"), "2026-03-09T06:30:00.000Z"],
  ["valid post-spring-transition wall time uses the new offset", "FREQ=DAILY;BYHOUR=3;BYMINUTE=30;BYSECOND=0", "America/New_York", "2026-03-08T05:00:00Z", new Date("2026-03-07T08:30:00Z"), "2026-03-08T07:30:00.000Z"],
  ["valid post-fall-transition wall time uses the new offset", "FREQ=DAILY;BYHOUR=2;BYMINUTE=30;BYSECOND=0", "America/New_York", "2026-11-01T04:00:00Z", new Date("2026-10-31T06:30:00Z"), "2026-11-01T07:30:00.000Z"],
  ["overlap uses only the first occurrence", "FREQ=DAILY;BYHOUR=1;BYMINUTE=30;BYSECOND=0", "America/New_York", "2026-11-01T04:00:00Z", new Date("2026-10-31T05:30:00Z"), "2026-11-01T05:30:00.000Z"],
  ["overlap never repeats the same local occurrence in the second fold", "FREQ=DAILY;BYHOUR=1;BYMINUTE=30;BYSECOND=0", "America/New_York", "2026-11-01T05:45:00Z", new Date("2026-10-31T05:30:00Z"), "2026-11-02T06:30:00.000Z"],
  ["weekly Monday phase finds Sunday in its first week", "FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;BYHOUR=9;BYMINUTE=0;BYSECOND=0;WKST=MO", "Asia/Shanghai", "2026-10-13T01:00:00Z", new Date("2026-10-13T01:00:00Z"), "2026-10-18T01:00:00.000Z"],
  ["weekly Sunday phase skips the intervening Sunday week", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;BYHOUR=9;BYMINUTE=0;BYSECOND=0;WKST=SU", "Asia/Shanghai", "2026-10-13T01:00:00Z", new Date("2026-10-13T01:00:00Z"), "2026-10-25T01:00:00.000Z"],
  ["daily periods jump beyond the former 370-day search window", "FREQ=DAILY;INTERVAL=500;BYHOUR=9;BYMINUTE=0;BYSECOND=0", "UTC", "2026-06-01T10:00:00Z", anchor, "2027-10-14T09:00:00.000Z"],
  ["query before anchor cannot execute an earlier date", "FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0;BYSECOND=0", "UTC", "2026-05-20T00:00:00Z", anchor, "2026-06-01T09:00:00.000Z"],
  ["omitted time fields belong to the anchor rather than each query", "FREQ=DAILY;INTERVAL=2", "UTC", "2026-06-03T15:00:00Z", new Date("2026-06-01T09:23:17Z"), "2026-06-05T09:23:17.000Z"],
  ["time lists are numeric-sorted rather than input ordered", "FREQ=DAILY;INTERVAL=2;BYHOUR=18,9;BYMINUTE=30,0;BYSECOND=20,0", "UTC", "2026-06-03T09:00:00Z", anchor, "2026-06-03T09:00:20.000Z"],
  ["daily interval uses local days across DST rather than 48 elapsed hours", "FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0;BYSECOND=0", "America/New_York", "2026-03-06T14:00:00Z", new Date("2026-03-06T14:00:00Z"), "2026-03-08T13:00:00.000Z"],
  ["fractional creation lower bound excludes the earlier whole-second occurrence", "FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0;BYSECOND=0", "UTC", "2026-05-20T00:00:00Z", new Date("2026-06-01T09:00:00.500Z"), "2026-06-03T09:00:00.000Z"],
  ["minutely phase preserves anchor milliseconds after refresh", "FREQ=MINUTELY;INTERVAL=2", "UTC", "2026-06-01T09:01:00Z", new Date("2026-06-01T09:00:00.500Z"), "2026-06-01T09:02:00.500Z"],
  ["Lord Howe half-hour spring gap skips rather than shifts the missing wall time", "FREQ=DAILY;BYHOUR=2;BYMINUTE=15;BYSECOND=0", "Australia/Lord_Howe", "2026-10-03T15:00:00Z", new Date("2026-10-02T15:45:00Z"), "2026-10-04T15:15:00.000Z"],
  ["Lord Howe half-hour overlap chooses the earlier occurrence", "FREQ=DAILY;BYHOUR=1;BYMINUTE=45;BYSECOND=0", "Australia/Lord_Howe", "2026-04-04T14:00:00Z", new Date("2026-04-03T14:45:00Z"), "2026-04-04T14:45:00.000Z"],
  ["Lord Howe half-hour overlap does not repeat its second fold", "FREQ=DAILY;BYHOUR=1;BYMINUTE=45;BYSECOND=0", "Australia/Lord_Howe", "2026-04-04T14:50:00Z", new Date("2026-04-03T14:45:00Z"), "2026-04-05T15:15:00.000Z"],
  ["the Unix epoch instant is a valid occurrence rather than a falsy miss", "FREQ=DAILY;BYHOUR=0;BYMINUTE=0;BYSECOND=0", "UTC", "1969-12-31T23:59:59Z", new Date("1969-12-31T00:00:00Z"), "1970-01-01T00:00:00.000Z"],
  ["years below 100 are not silently interpreted as twentieth-century dates", "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0", "UTC", "0099-06-02T08:00:00Z", new Date("0099-06-01T09:00:00Z"), "0099-06-02T09:00:00.000Z"],
  ["astronomical year zero preserves its BC era during exact roundtrip", "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0", "UTC", "0000-06-02T08:00:00Z", new Date("0000-06-01T09:00:00Z"), "0000-06-02T09:00:00.000Z"],
];

for (const [name, rule, zone, from, start, expected] of cases) {
  test(`A09 ${name}`, () => {
    assert.equal(computeNextRunAtFromRRule(rule, zone, new Date(from), start), expected);
  });
}

test("A09 production recurrence passes the durable creation anchor, not the query time", () => {
  const automation = {
    createdAt: anchor.toISOString(),
    trigger: { type: "schedule", timezone: "UTC", schedule: { cadence: "daily", timeOfDay: "09:00" }, missedRunPolicy: "skip" },
    rrule: "FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
  };
  assert.equal(computeNextAutomationRunAt(automation, new Date("2026-06-03T10:00:00Z")), "2026-06-05T09:00:00.000Z");
});

for (const rule of [
  "FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;INTERVAL=2x", "FREQ=DAILY;INTERVAL=1.5",
  "FREQ=DAILY;BYHOUR=24", "FREQ=WEEKLY;BYDAY=1MO", "FREQ=WEEKLY;WKST=XX",
  "FREQ=DAILY;COUNT=2", "FREQ=DAILY;UNTIL=20260603T090000Z", "FREQ=DAILY;FREQ=WEEKLY",
  "FREQ=MINUTELY;BYDAY=MO", "FREQ=MINUTELY;BYHOUR=9", "FREQ=MINUTELY;WKST=MO",
  "FREQ=DAILY;BYMINUTE=-1", "FREQ=DAILY;BYSECOND=60", "FREQ=DAILY;BYHOUR=9,",
  "FREQ=DAILY;INTERVAL=9007199254740992", "FREQ=DAILY;DTSTART=20260601T090000Z",
]) {
  test(`A09 unsupported or malformed recurrence is not silently widened: ${rule}`, () => {
    assert.equal(computeNextRunAtFromRRule(rule, "UTC", new Date("2026-06-02T12:00:00Z"), anchor), undefined);
    assert.throws(() => computeNextAutomationRunAt({ createdAt: anchor.toISOString(), rrule: rule,
      trigger: { type: "schedule", timezone: "UTC", schedule: { cadence: "daily", timeOfDay: "09:00" }, missedRunPolicy: "skip" },
    }, new Date("2026-06-02T12:00:00Z")), /recurrence|rrule/i);
  });
}

test("A09 invalid creation anchor and impossible weekday intersection fail closed", () => {
  assert.equal(computeNextRunAtFromRRule("FREQ=DAILY;INTERVAL=2", "UTC", anchor, new Date("invalid")), undefined);
  assert.equal(computeNextRunAtFromRRule("FREQ=DAILY;INTERVAL=7;BYDAY=TU", "UTC", anchor, anchor), undefined);
  assert.equal(computeNextRunAtFromRRule("FREQ=MINUTELY;INTERVAL=9007199254740991", "UTC", anchor, anchor), undefined);
});

test("A09 dense valid time lists do not resolve every elapsed second on refresh", (t) => {
  const original = Intl.DateTimeFormat.prototype.formatToParts;
  let resolutions = 0;
  t.mock.method(Intl.DateTimeFormat.prototype, "formatToParts", function (...args) {
    resolutions += 1;
    return original.apply(this, args);
  });
  const list = (count) => Array.from({ length: count }, (_, index) => index).join(",");
  const rule = `FREQ=DAILY;BYHOUR=${list(24)};BYMINUTE=${list(60)};BYSECOND=${list(60)}`;
  assert.equal(computeNextRunAtFromRRule(rule, "UTC", new Date("2026-06-02T23:59:59Z"), anchor),
    "2026-06-03T00:00:00.000Z");
  assert.ok(resolutions < 100, `Elapsed local seconds should be skipped before timezone resolution; calls=${resolutions}`);
});

for (const scenario of [
  {
    name: "dense New York spring gap skips nonexistent wall seconds within a timezone-call budget",
    zone: "America/New_York", hours: "2,3", from: "2026-03-08T06:59:59Z",
    start: "2026-03-07T07:00:00Z", expected: "2026-03-08T07:00:00.000Z",
  },
  {
    name: "dense Apia skipped day skips nonexistent wall seconds within a timezone-call budget",
    zone: "Pacific/Apia", hours: Array.from({ length: 24 }, (_, index) => index).join(","),
    from: "2011-12-30T09:59:59Z", start: "2011-12-29T10:00:00Z", expected: "2011-12-30T10:00:00.000Z",
  },
  {
    name: "dense Lord Howe half-hour spring gap skips nonexistent wall seconds within a timezone-call budget",
    zone: "Australia/Lord_Howe", hours: "2", from: "2026-10-03T15:29:59Z",
    start: "2026-10-02T15:30:00Z", expected: "2026-10-03T15:30:00.000Z",
  },
  {
    name: "dense New York second fold skips all elapsed first-fold seconds within a timezone-call budget",
    zone: "America/New_York", hours: "1,2", from: "2026-11-01T06:00:00Z",
    start: "2026-10-31T05:00:00Z", expected: "2026-11-01T07:00:00.000Z",
  },
]) {
  test(`A09 ${scenario.name}`, (t) => {
    const original = Intl.DateTimeFormat.prototype.formatToParts;
    let resolutions = 0;
    t.mock.method(Intl.DateTimeFormat.prototype, "formatToParts", function (...args) {
      resolutions += 1;
      return original.apply(this, args);
    });
    const minutesAndSeconds = Array.from({ length: 60 }, (_, index) => index).join(",");
    const rule = `FREQ=DAILY;BYHOUR=${scenario.hours};BYMINUTE=${minutesAndSeconds};BYSECOND=${minutesAndSeconds}`;
    assert.equal(computeNextRunAtFromRRule(rule, scenario.zone, new Date(scenario.from), new Date(scenario.start)), scenario.expected);
    assert.ok(resolutions <= 128,
      `Timezone resolution must scale with wall-interval boundaries, not each nonexistent or elapsed first-fold second; calls=${resolutions}`);
    t.diagnostic(JSON.stringify({ timezone: scenario.zone, expectedNext: scenario.expected, formatToPartsCalls: resolutions, budget: 128 }));
  });
}

test("A09 scheduled validation distinguishes typed recurrence failures and preserves their causes", () => {
  const automation = {
    createdAt: anchor.toISOString(),
    trigger: { type: "schedule", timezone: "Invalid/Timezone", schedule: { cadence: "daily", timeOfDay: "09:00" }, missedRunPolicy: "skip" },
    rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
  };
  assert.throws(() => assertAutomationRecurrence(automation, anchor), (error) => {
    assert.ok(error instanceof AutomationRecurrenceError);
    assert.match(error.message, /recurrence/i);
    assert.ok(error.cause instanceof RangeError);
    return true;
  });
  assert.throws(() => computeNextAutomationRunAt({ ...automation, rrule: "FREQ=DAILY;COUNT=2",
    trigger: { ...automation.trigger, timezone: "UTC" } }, anchor), AutomationRecurrenceError);
  assert.throws(() => computeNextAutomationRunAt({ ...automation, rrule: undefined,
    trigger: { ...automation.trigger, timezone: "UTC", schedule: { cadence: "interval", everyMs: 1000 } } }, new Date("invalid")), (error) => {
    assert.ok(error instanceof AutomationRecurrenceError);
    assert.ok(error.cause instanceof RangeError);
    return true;
  });
});

test("A09 Date range exhaustion fails closed with a typed production recurrence error", () => {
  const from = new Date(8_640_000_000_000_000);
  const start = new Date(from.getTime() - 86_400_000);
  const rule = "FREQ=DAILY;BYHOUR=0;BYMINUTE=0;BYSECOND=0";
  assert.equal(computeNextRunAtFromRRule(rule, "UTC", from, start), undefined);
  assert.throws(() => computeNextAutomationRunAt({ createdAt: start.toISOString(), rrule: rule,
    trigger: { type: "schedule", timezone: "UTC", schedule: { cadence: "daily", timeOfDay: "00:00" }, missedRunPolicy: "skip" },
  }, from), AutomationRecurrenceError);
});

test("A09 non-scheduled validation is a no-op even when unused recurrence fields are invalid", () => {
  assert.doesNotThrow(() => assertAutomationRecurrence({ createdAt: "invalid", rrule: "unsupported",
    trigger: { type: "manual" },
  }, new Date("invalid")));
});
