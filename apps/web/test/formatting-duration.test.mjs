import assert from "node:assert/strict";
import test from "node:test";
import * as formatting from "../src/lib/formatting.ts";

test("unknown metadata timestamps never turn into a localized 1969 or 1970 update date", () => {
  assert.equal(typeof formatting.formatKnownDateTime, "function");
  for (const value of ["1970-01-01T00:00:00.000Z", "", "invalid"]) {
    assert.equal(formatting.formatKnownDateTime(value, "Built-in"), "Built-in");
    assert.equal(formatting.formatKnownDateTime(value, "未提供"), "未提供");
  }
  const actual = "2026-10-22T09:42:00.000Z";
  assert.equal(formatting.formatKnownDateTime(actual, "Built-in"), formatting.formatDateTime(actual));
});

test("process durations use localized whole hours, minutes and seconds", () => {
  assert.equal(typeof formatting.formatElapsedDuration, "function");
  for (const [duration, expected] of [
    [0, "0秒"], [999, "0秒"], [1000, "1秒"], [59_999, "59秒"],
    [60_000, "1分钟"], [61_000, "1分钟1秒"], [101_000, "1分钟41秒"],
    [1_189_300, "19分钟49秒"], [3_599_999, "59分钟59秒"],
    [3_600_000, "1小时"], [3_661_000, "1小时1分钟1秒"],
    [90_061_000, "25小时1分钟1秒"],
  ]) assert.equal(formatting.formatElapsedDuration(duration, "zh-CN"), expected, String(duration));
});

test("elapsed formatting follows app locale rather than machine locale", () => {
  assert.equal(formatting.formatElapsedDuration(1_189_300, "en-US"), "19m 49s");
  assert.equal(formatting.formatElapsedDuration(3_661_000, "en-US"), "1h 1m 1s");
  assert.equal(formatting.formatElapsedDuration(1000, "en-US"), "1s");
});

test("absent and invalid elapsed facts remain absent, never NaN or a false zero", () => {
  for (const value of [undefined, -1, NaN, Infinity, -Infinity]) {
    assert.equal(formatting.formatElapsedDuration(value, "zh-CN"), undefined);
  }
});
