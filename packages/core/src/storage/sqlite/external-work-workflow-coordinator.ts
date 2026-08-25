import {
  createExternalWorkId,
  type CreateExternalWorkWorkflowInput,
  type ExternalWorkRecord,
  type ExternalWorkWorkflowResult,
} from "../../external-work-types.js";
import {
  DEFAULT_WORKSPACE_ID,
  type Channel,
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type CreateChannelWorkflowInput,
  type CreateChannelWorkflowStepInput,
} from "../../workspace-types.js";
import { createWorkflowParticipantAuthorityV1 } from "@ling-stack/contracts";

export interface SqliteExternalWorkWorkflowCoordinatorPorts {
  readonly assertChannelExists: (channelId: string) => void;
  readonly getChannel: (channelId: string) => Channel | undefined;
  readonly getExternalWorkRecordByIdempotency: (
    sourceKind: ExternalWorkRecord["sourceKind"],
    idempotencyKey: string,
  ) => ExternalWorkRecord | undefined;
  readonly createExternalWorkRecord: (record: ExternalWorkRecord) => ExternalWorkRecord;
  readonly getChannelWorkflow: (workflowId: string) => ChannelWorkflow | undefined;
  readonly createChannelWorkflow: (input: CreateChannelWorkflowInput, now: string) => ChannelWorkflow;
  readonly getChannelWorkflowStep: (workflowStepId: string) => ChannelWorkflowStep | undefined;
  readonly createChannelWorkflowStep: (input: CreateChannelWorkflowStepInput, now: string) => ChannelWorkflowStep;
}

export class SqliteExternalWorkWorkflowCoordinator {
  constructor(private readonly ports: SqliteExternalWorkWorkflowCoordinatorPorts) {}

  createOrReuseExternalWorkWorkflow(input: CreateExternalWorkWorkflowInput, now: string): ExternalWorkWorkflowResult {
    this.ports.assertChannelExists(input.channelId);
    const existing = this.ports.getExternalWorkRecordByIdempotency(
      input.externalWorkItem.sourceKind,
      input.externalWorkItem.idempotencyKey,
    );
    if (existing) {
      const workflow = this.ports.getChannelWorkflow(existing.workflowId);
      const workflowStep = this.ports.getChannelWorkflowStep(existing.workflowStepId);
      if (!workflow || !workflowStep) {
        throw new Error(`External work mapping points to missing workflow state: ${existing.id}`);
      }
      return {
        externalWork: existing,
        workflow,
        workflowStep,
        duplicate: true,
      };
    }

    const channel = this.ports.getChannel(input.channelId);
    if (!channel) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const participantId = input.toParticipantId ?? channel.defaultTeammateId ?? input.workflowDefinition.config.agent.teammateId ?? "engineer";
    const participantLabel = input.toParticipantLabel ?? labelForParticipant(participantId);
    const workflow = this.ports.createChannelWorkflow(
      {
        channelId: input.channelId,
        title: `External work: ${input.externalWorkItem.identifier}`,
        objective: `Handle ${input.externalWorkItem.kind} ${input.externalWorkItem.identifier}: ${input.externalWorkItem.title}`,
        status: "ready",
        createdBy: `${input.externalWorkItem.sourceKind}:external-work`,
      },
      now,
    );
    const workflowStep = this.ports.createChannelWorkflowStep(
      {
        workflowId: workflow.id,
        title: `Review ${input.externalWorkItem.identifier}`,
        prompt: input.renderedPrompt,
        toParticipantId: participantId,
        toParticipantLabel: participantLabel,
        participantAuthority: createWorkflowParticipantAuthorityV1({
          kind: "workflow_definition",
          origin: "external_work",
          participantId,
          sourceId: input.externalWorkItem.id,
        }),
      },
      now,
    );
    const record: ExternalWorkRecord = {
      id: createExternalWorkId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceKind: input.externalWorkItem.sourceKind,
      workItemKind: input.externalWorkItem.kind,
      externalId: input.externalWorkItem.id,
      identifier: input.externalWorkItem.identifier,
      idempotencyKey: input.externalWorkItem.idempotencyKey,
      workflowId: workflow.id,
      workflowStepId: workflowStep.id,
      artifactIds: [],
      item: input.externalWorkItem,
      createdAt: now,
      updatedAt: now,
    };

    const created = this.ports.createExternalWorkRecord(record);
    return {
      externalWork: created,
      workflow,
      workflowStep,
      duplicate: false,
    };
  }
}

function labelForParticipant(participantId: string): string {
  if (participantId === "engineer" || participantId === "teammate_builtin_engineer") {
    return "Engineer";
  }
  return participantId;
}
