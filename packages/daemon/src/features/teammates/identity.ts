import {
  createBuiltinAiTeammateId,
  type AiTeammate,
  type TeammateStoreFacet,
} from "@ling-stack/core";

export function resolveAiTeammateReference(store: TeammateStoreFacet, teammateId: string): AiTeammate | undefined {
  return store.getAiTeammate(teammateId) ?? store.getAiTeammate(createBuiltinAiTeammateId(teammateId));
}
