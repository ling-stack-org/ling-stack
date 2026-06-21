import type { ChannelExecutionProposalStepSource, RunStore } from "@ling-stack/core";

export interface ResolvedCouncilSlotParticipant {
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly sources: readonly ChannelExecutionProposalStepSource[];
}

export function resolveCouncilSlotParticipant(
  store: RunStore,
  channelId: string,
  councilSlotKey: string,
): ResolvedCouncilSlotParticipant | undefined {
  const slotKey = councilSlotKey.trim();
  if (!slotKey) {
    return undefined;
  }
  const effectiveCouncil = store.getEffectiveChannelCouncil(channelId);
  if (!effectiveCouncil) {
    return undefined;
  }

  const councilById = new Map(effectiveCouncil.councils.map((entry) => [entry.council.id, entry]));
  const orderedCouncilIds = dedupeStrings([
    effectiveCouncil.policy.preferredCouncilId,
    ...effectiveCouncil.policy.attachedCouncilIds,
    ...effectiveCouncil.councils.map((entry) => entry.council.id),
  ].filter(isString));

  for (const councilId of orderedCouncilIds) {
    const councilEntry = councilById.get(councilId);
    if (!councilEntry) {
      continue;
    }
    const memberEntry = councilEntry.members.find((candidate) =>
      candidate.enabled &&
      candidate.teammate &&
      candidate.member.slotKey === slotKey
    );
    if (!memberEntry?.teammate) {
      continue;
    }
    const source: ChannelExecutionProposalStepSource = {
      kind: "council",
      councilId: councilEntry.council.id,
      councilDisplayName: councilEntry.council.displayName,
      ...(memberEntry.member.slotKey ? { slotKey: memberEntry.member.slotKey } : {}),
      ...(memberEntry.member.label ? { label: memberEntry.member.label } : {}),
    };
    return {
      toParticipantId: memberEntry.teammate.id,
      toParticipantLabel: memberEntry.teammate.displayName,
      sources: [source],
    };
  }

  return undefined;
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}
