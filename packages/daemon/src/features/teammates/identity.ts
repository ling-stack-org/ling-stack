import {
  createBuiltinAiTeammateId,
  type AiTeammate,
  type RunStore,
} from "@ling-stack/core";

export function resolveAiTeammateReference(store: RunStore, teammateId: string): AiTeammate | undefined {
  return store.getAiTeammate(teammateId) ?? store.getAiTeammate(createBuiltinAiTeammateId(teammateId));
}
