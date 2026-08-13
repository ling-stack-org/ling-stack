import {
  mediaGenerationTargetRefKey,
  type MediaGenerationKind,
  type MediaGenerationTargetRef,
  type MediaGenerationTargetResolution,
  type MediaGenerationTargetSummary,
} from "./media-generation-routing-types.js";

export function resolveMediaGenerationTarget(input: {
  readonly generationKind: MediaGenerationKind;
  readonly requestedTarget?: string;
  readonly defaultTarget?: MediaGenerationTargetRef;
  readonly targets: readonly MediaGenerationTargetSummary[];
}): MediaGenerationTargetResolution {
  const candidates = input.targets.filter((target) => target.generationKind === input.generationKind);
  const runnable = candidates.filter((target) => target.runnable);
  const requested = input.requestedTarget?.trim();

  if (requested) {
    const normalized = normalizeTargetLabel(requested);
    const matches = candidates.filter((target) => targetLabels(target).some((label) => normalizeTargetLabel(label) === normalized));
    if (matches.length > 1) {
      return failure(
        "generation_target_ambiguous",
        `Generation target is ambiguous: ${requested}`,
        matches.filter((target) => target.runnable),
      );
    }
    const match = matches[0];
    if (!match) {
      return failure("generation_target_not_found", `Generation target was not found: ${requested}`, runnable);
    }
    if (!match.runnable) {
      return failure(
        "generation_target_not_runnable",
        match.unavailableReason ?? `Generation target is not runnable: ${match.displayName}`,
        runnable,
      );
    }
    return { ok: true, target: match, source: "explicit" };
  }

  if (input.defaultTarget) {
    const defaultKey = mediaGenerationTargetRefKey(input.defaultTarget);
    const target = candidates.find((candidate) => mediaGenerationTargetRefKey(candidate.ref) === defaultKey);
    if (!target || !target.runnable) {
      return failure(
        "generation_target_not_runnable",
        target?.unavailableReason ?? "The workspace default generation target is unavailable.",
        runnable,
      );
    }
    return { ok: true, target, source: "workspace_default" };
  }

  if (runnable.length === 1) {
    return { ok: true, target: runnable[0], source: "only_runnable" };
  }
  if (runnable.length > 1) {
    return failure(
      "target_selection_required",
      `Choose a ${input.generationKind} generation target before continuing.`,
      runnable,
    );
  }
  return failure(
    "generation_target_unavailable",
    `No runnable ${input.generationKind} generation target is configured.`,
    [],
  );
}

function targetLabels(target: MediaGenerationTargetSummary): string[] {
  return [target.id, target.displayName, ...target.aliases];
}

function normalizeTargetLabel(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function failure(
  code: Exclude<MediaGenerationTargetResolution, { readonly ok: true }>["code"],
  message: string,
  candidates: readonly MediaGenerationTargetSummary[],
): MediaGenerationTargetResolution {
  return { ok: false, code, message, candidates };
}
