import type { RunStore } from "@ling-stack/core";
import { HttpError } from "../errors.js";

export function withCancellationFence<T>(store: Pick<RunStore, "withCancellationFence">, input: Parameters<RunStore["withCancellationFence"]>[0],
  mutate: Parameters<RunStore["withCancellationFence"]>[1]): T {
  try {
    return store.withCancellationFence(input, mutate) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "stale_cancellation") {
      throw new HttpError(409, "stale_cancellation", "The original execution is no longer the cancellation target.");
    }
    throw error;
  }
}
