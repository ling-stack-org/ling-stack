/** New captures only. Frozen snapshots keep their original read contract. */
export const MAX_NORMAL_CONTEXT_CAPTURE_BYTES = 2_000_000;

export function normalContextSerializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** A failed capture propagates through the caller's accept/fork transaction. */
export function assertNormalContextCaptureByteBudget(value: unknown): void {
  if (normalContextSerializedBytes(value) > MAX_NORMAL_CONTEXT_CAPTURE_BYTES) {
    throw new Error("Normal context capture exceeds the bounded metadata byte budget");
  }
}

/** Retained groups/diagnostics have a separate cumulative bound, even for empty text. */
export function createNormalContextRetainedMetadataBudget(): (value: unknown) => void {
  let usedBytes = 0;
  return value => {
    usedBytes += normalContextSerializedBytes(value);
    if (usedBytes > MAX_NORMAL_CONTEXT_CAPTURE_BYTES) {
      throw new Error("Normal context capture exceeds the retained metadata byte budget");
    }
  };
}
