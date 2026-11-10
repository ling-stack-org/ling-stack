/** Read the optional whole-item cap without inventing a cap for existing callers. */
export function readAutomationContextItemBudget(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("promptTemplate.maxContextItems must be a positive safe integer");
  }
  return value;
}
