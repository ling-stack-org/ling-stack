import { isDeepStrictEqual } from "node:util";
import {
  REMOTE_DEVICE_COLLABORATION_MAX_MS,
  REMOTE_DEVICE_COLLABORATION_MAX_NOTE_BYTES,
  REMOTE_DEVICE_COLLABORATION_MAX_PROPOSALS,
  REMOTE_DEVICE_COLLABORATION_MAX_SHARES,
  type DeviceCollaborationProposalV1,
  type RemoteDeviceAnalysisInputV1,
  type RemoteDeviceAnalysisDraftInputV1,
  type RemoteDeviceCollaborationCommandV1,
  type RemoteDeviceCollaborationViewV1,
} from "@ling-stack/contracts";
import { digestCollaborationPayload, type PhoneTaskShareRecord, type SqliteDeviceDeveloperStore } from "@ling-stack/core";
import { RemoteAccessError } from "./errors.js";

export interface PhoneTaskCollaborationPrincipal {
  readonly gatewayId: string;
  readonly deviceId: string;
  readonly deviceEpoch: number;
  readonly workspaceId: string;
  readonly workspaceBindingId: string;
  readonly policyVersion: number;
}

export class PhoneTaskCollaboration {
  constructor(private readonly store: SqliteDeviceDeveloperStore) {}

  fromPhone(principal: PhoneTaskCollaborationPrincipal, command: RemoteDeviceCollaborationCommandV1, now: string): RemoteDeviceCollaborationViewV1 {
    const { action, shareId } = command;
    if (command.workspaceId !== principal.workspaceId) {
      throw new RemoteAccessError("workspace_not_allowed", "This collaboration belongs to another workspace.");
    }
    if (action.kind === "read") return this.view(this.requireShare(principal, shareId), principal.workspaceId, now);
    return this.store.withWriteTransaction(() => {
      if (action.kind === "publish") {
        return this.view(this.publish(principal, shareId, action, now), principal.workspaceId, now);
      }
      const share = this.requireShare(principal, shareId);
      if (action.kind === "revoke") {
        if (!share.projection) return this.view(share, principal.workspaceId, now);
        this.expirePendingProposals(share);
        this.store.savePhoneTaskShare({ ...share, projection: undefined, proposalIds: [], revision: share.revision + 1 });
        return { workspaceId: principal.workspaceId, shareId, revision: share.revision + 1, expiresAt: share.expiresAt, state: "revoked" };
      }
      this.assertActive(share, now);
      requireRevision(share, action.expectedRevision);
      const proposal = share.proposalIds.includes(action.proposalId) && this.store.getProposal(action.proposalId);
      if (!proposal || (proposal.status !== "proposed" && proposal.status !== action.decision)) {
        throw new RemoteAccessError("idempotency_conflict", "This proposal can no longer be decided.");
      }
      if (proposal.status === "proposed") this.store.saveProposal({ ...proposal, status: action.decision });
      return this.view(share, principal.workspaceId, now);
    });
  }

  listForPc(principal: PhoneTaskCollaborationPrincipal, now: string): readonly RemoteDeviceCollaborationViewV1[] {
    return this.activeShares(principal, now).map(share => this.view(share, principal.workspaceId, now));
  }

  projectionForAnalysis(principal: PhoneTaskCollaborationPrincipal, input: RemoteDeviceAnalysisDraftInputV1, now: string) {
    const share = this.requireShare(principal, input.shareId);
    const projection = this.assertActive(share, now);
    requireRevision(share, input.expectedRevision);
    return projection;
  }

  proposeFromPc(principal: PhoneTaskCollaborationPrincipal, input: RemoteDeviceAnalysisInputV1, now: string): RemoteDeviceCollaborationViewV1 {
    const { shareId, expectedRevision, proposalId } = input;
    const text = input.text.trim();
    if (!text || Buffer.byteLength(text, "utf8") > REMOTE_DEVICE_COLLABORATION_MAX_NOTE_BYTES) {
      throw new RemoteAccessError("payload_too_large", "Enter an analysis note within the size limit.");
    }
    return this.store.withWriteTransaction(() => {
      const share = this.requireShare(principal, shareId);
      const projection = this.assertActive(share, now);
      requireRevision(share, expectedRevision);
      const payload = { text };
      const payloadDigest = digestCollaborationPayload(payload);
      const previous = this.store.getProposal(proposalId);
      if (previous) {
        if (!share.proposalIds.includes(proposalId) || previous.payloadDigest !== payloadDigest) {
          throw new RemoteAccessError("idempotency_conflict", "This proposal identifier already belongs to another note.");
        }
        return this.view(share, principal.workspaceId, now);
      }
      if (share.proposalIds.length >= REMOTE_DEVICE_COLLABORATION_MAX_PROPOSALS) {
        throw new RemoteAccessError("rate_limited", "The analysis note limit has been reached for this task revision.");
      }
      const proposal: DeviceCollaborationProposalV1 = {
        proposalId, taskId: projection.taskId, targetDeviceId: projection.targetDeviceId,
        ownerKind: "mobile", ownerId: projection.ownerId, proposerKind: "daemon", proposerId: principal.gatewayId,
        kind: "observation", payload, payloadDigest, baseRevision: `${shareId}:${share.revision}`,
        status: "proposed", createdAt: now, expiresAt: share.expiresAt,
      };
      this.store.saveProposal(proposal);
      const next = { ...share, proposalIds: [...share.proposalIds, proposalId] };
      this.store.savePhoneTaskShare(next);
      return this.view(next, principal.workspaceId, now);
    });
  }

  private publish(
    principal: PhoneTaskCollaborationPrincipal,
    shareId: string,
    { expectedRevision, expiresAt, projection }: Extract<RemoteDeviceCollaborationCommandV1["action"], { kind: "publish" }>,
    now: string,
  ): PhoneTaskShareRecord {
    const bound = principalKey(principal);
    const previous = this.store.getPhoneTaskShare(shareId);
    if (!previous) {
      requireRevision({ revision: 0 }, expectedRevision);
      if (expiresAt <= now || Date.parse(expiresAt) - Date.parse(now) > REMOTE_DEVICE_COLLABORATION_MAX_MS) {
        throw new RemoteAccessError("command_expired", "The collaboration deadline is outside the accepted range.");
      }
      const active = this.activeShares(principal, now);
      if (active.some(share => share.projection?.taskId === projection.taskId)) {
        throw new RemoteAccessError("idempotency_conflict", "This task already has an active share for the pairing.");
      }
      if (active.length >= REMOTE_DEVICE_COLLABORATION_MAX_SHARES) {
        throw new RemoteAccessError("rate_limited", "The paired phone has reached its active collaboration limit.");
      }
      const share = { shareId, principal: bound, revision: 1, expiresAt, projection, proposalIds: [] };
      this.store.savePhoneTaskShare(share);
      return share;
    }
    if (previous.principal !== bound) throw bindingChanged();
    const current = this.assertActive(previous, now);
    if (current.taskId !== projection.taskId || current.ownerId !== projection.ownerId
      || current.targetDeviceId !== projection.targetDeviceId || previous.expiresAt !== expiresAt) throw bindingChanged();
    if ((previous.revision === expectedRevision || previous.revision === expectedRevision + 1)
      && isDeepStrictEqual(current, projection)) return previous;
    requireRevision(previous, expectedRevision);
    if (current.updatedAt > projection.updatedAt) {
      throw new RemoteAccessError("resync_required", "The phone task projection is older than the retained version.", true);
    }
    this.expirePendingProposals(previous);
    const share = { ...previous, revision: previous.revision + 1, projection, proposalIds: [] };
    this.store.savePhoneTaskShare(share);
    return share;
  }

  private activeShares(principal: PhoneTaskCollaborationPrincipal, now: string) {
    return this.store.listActivePhoneTaskShares(principalKey(principal), now, REMOTE_DEVICE_COLLABORATION_MAX_SHARES);
  }

  private requireShare(principal: PhoneTaskCollaborationPrincipal, shareId: string): PhoneTaskShareRecord {
    const share = this.store.getPhoneTaskShare(shareId);
    if (!share || share.principal !== principalKey(principal)) throw bindingChanged();
    return share;
  }

  private assertActive(share: PhoneTaskShareRecord, now: string) {
    if (!share.projection || share.expiresAt <= now) throw new RemoteAccessError("command_expired", "This collaboration has ended.");
    return share.projection;
  }

  private expirePendingProposals(share: PhoneTaskShareRecord): void {
    for (const id of share.proposalIds) {
      const proposal = this.store.getProposal(id);
      if (proposal?.status === "proposed") this.store.saveProposal({ ...proposal, status: "expired" });
    }
  }

  private view(share: PhoneTaskShareRecord, workspaceId: string, now: string): RemoteDeviceCollaborationViewV1 {
    const { shareId, revision, expiresAt, projection } = share;
    const common = { workspaceId, shareId, revision, expiresAt };
    if (!projection) return { ...common, state: "revoked" };
    if (expiresAt <= now) return { ...common, state: "expired" };
    const proposals = share.proposalIds.flatMap(proposalId => {
      const proposal = this.store.getProposal(proposalId);
      if (!proposal || proposal.status === "expired" || !proposal.payload || typeof proposal.payload !== "object"
        || !("text" in proposal.payload) || typeof proposal.payload.text !== "string") return [];
      return [{ proposalId, status: proposal.status, text: proposal.payload.text, createdAt: proposal.createdAt }];
    });
    return { ...common, state: "active", projection, proposals };
  }
}

function principalKey(principal: PhoneTaskCollaborationPrincipal): string {
  return JSON.stringify([
    principal.gatewayId, principal.deviceId, principal.deviceEpoch,
    principal.workspaceId, principal.workspaceBindingId, principal.policyVersion,
  ]);
}

function bindingChanged(): RemoteAccessError {
  return new RemoteAccessError("binding_changed", "The task share is unavailable to this pairing.");
}

function requireRevision(share: { readonly revision: number }, expected: number): void {
  if (share.revision !== expected) {
    throw new RemoteAccessError("resync_required", "The shared task changed. Refresh before continuing.", true);
  }
}
