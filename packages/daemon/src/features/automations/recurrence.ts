// API, scheduling and SQLite admission share the same domain calculation.
export {
  AutomationRecurrenceCompleteError,
  AutomationRecurrenceError,
  assertAutomationRecurrence,
  computeNextAutomationRunAt,
  computeNextRunAt,
  computeNextRunAtFromRRule,
  isSupportedAutomationRRule,
} from "@ling-stack/core";
