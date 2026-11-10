import type { AiTeammate, RunTool } from "@ling-stack/core";
import type { ChannelIntentExecutionOperationV1 } from "@ling-stack/contracts";

export interface ExecutionOperationParticipant {
  readonly teammate: Pick<AiTeammate, "roleKey"> & Partial<Pick<AiTeammate, "id">>;
}

export function assignExecutionOperationOwners(
  operations: readonly ChannelIntentExecutionOperationV1[],
  participants: readonly ExecutionOperationParticipant[],
): Map<string, number> {
  const owners = new Map<string, number>();
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  const resolving = new Set<string>();
  const resolveOwner = (operation: ChannelIntentExecutionOperationV1): number => {
    const existing = owners.get(operation.id);
    if (existing !== undefined) return existing;
    if (operation.binding) {
      const boundOwner = participants.findIndex((participant) => participant.teammate.id === operation.binding!.ownerParticipantId);
      if (boundOwner < 0) throw new Error(`operation_owner_not_available:${operation.id}:${operation.binding.ownerParticipantId}`);
      owners.set(operation.id, boundOwner);
      return boundOwner;
    }
    if (resolving.has(operation.id)) return 0;
    resolving.add(operation.id);
    const minimumOwner = Math.max(0, ...operation.dependsOn.map((dependencyId) => {
      const dependency = byId.get(dependencyId);
      return dependency ? resolveOwner(dependency) : 0;
    }));
    let owner: number;
    if (operation.kind === "file_create" || operation.kind === "file_edit") {
      const preferredOwner = participants.findIndex((participant, index) =>
        index >= minimumOwner && (participant.teammate.roleKey === "engineer" || participant.teammate.roleKey === "docs"));
      owner = preferredOwner >= 0 ? preferredOwner : minimumOwner;
    } else if (operation.kind === "run_command" || operation.kind === "open_local_target") {
      let preferredOwner = -1;
      for (let index = participants.length - 1; index >= minimumOwner; index -= 1) {
        const roleKey = participants[index]?.teammate.roleKey;
        if (roleKey === "qa" || roleKey === "release") {
          preferredOwner = index;
          break;
        }
      }
      owner = preferredOwner >= 0 ? preferredOwner : Math.max(minimumOwner, participants.length - 1);
    } else {
      owner = minimumOwner;
    }
    resolving.delete(operation.id);
    owners.set(operation.id, owner);
    return owner;
  };
  for (const operation of operations) resolveOwner(operation);
  return owners;
}

export function ownedExecutionOperations(
  operations: readonly ChannelIntentExecutionOperationV1[],
  owners: ReadonlyMap<string, number>,
  participantIndex: number,
): readonly ChannelIntentExecutionOperationV1[] {
  return operations.filter((operation) => owners.get(operation.id) === participantIndex);
}

export function requiredToolsForExecutionOperations(
  operations: readonly ChannelIntentExecutionOperationV1[],
): readonly RunTool[] {
  return [...new Set(operations.flatMap((operation): RunTool[] => {
    switch (operation.kind) {
      case "file_read": return ["read"];
      case "file_create": return ["write"];
      case "file_edit": return ["edit"];
      case "run_command": return ["bash"];
      case "open_local_target": return [];
      default: throw new Error(`unsupported_execution_operation:${String(operation.kind)}`);
    }
  }))];
}
