import {
  isTerminalComputerUseStatus,
  type ComputerUsePreviewProjection,
} from "@ling-stack/contracts";
import type { ComputerUsePipDeckScope } from "./deck.js";
import { compareLatestComputerUseProjection } from "./selectors.js";

/**
 * Selects every preview-capable session in one exact Desktop-owned deck scope.
 *
 * Workspace identity is enforced by the coordinator that owns the projection
 * registry. This selector intentionally accepts only the already-bound scope
 * and never guesses an owner from rendered text or route fragments.
 */
export function selectComputerUsePipDeckProjections(input: {
  readonly scope: ComputerUsePipDeckScope;
  readonly projections: readonly ComputerUsePreviewProjection[];
}): readonly ComputerUsePreviewProjection[] {
  return input.projections
    .filter((projection) => projection.conversationId === input.scope.ownerId)
    .filter((projection) => !isTerminalComputerUseStatus(projection.status))
    .filter((projection) => projection.preview !== undefined)
    .sort(compareLatestComputerUseProjection);
}
