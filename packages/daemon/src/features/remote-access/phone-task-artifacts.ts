import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import {
  REMOTE_DEVICE_ARTIFACT_CHUNK_BYTES, REMOTE_DEVICE_ARTIFACT_MAX_BYTES, REMOTE_DEVICE_COLLABORATION_MAX_MS,
  REMOTE_DEVICE_COLLABORATION_MAX_PROPOSALS, REMOTE_PROTOCOL_LIMITS, isAndroidApkFileName, isRemoteDeviceArtifactName,
  type AndroidApkIdentityV1, type RemoteDeviceArtifactBuildOfferInputV1,
  type DeviceCollaborationProposalV1, type RemoteDeviceArtifactCommandV1, type RemoteDeviceArtifactManifestV1,
  type RemoteDeviceArtifactOfferInputV1, type RemoteDeviceArtifactOfferV1, type RemoteDeviceArtifactResultV1,
  type RemoteDeviceBuildArtifactSummaryV1,
} from "@ling-stack/contracts";
import { digestCollaborationPayload, type PhoneTaskShareRecord, type SqliteDeviceDeveloperStore } from "@ling-stack/core";
import {
  deviceArtifactChunkBytes, deviceArtifactManifestBytes, deviceArtifactReceiptBytes, phoneTaskProjectionDigest, validateDeviceArtifactOffer,
} from "@ling-stack/remote-protocol";
import type { AndroidApkLibrary } from "../device-support/android-apks.js";
import { readProjectBuildArtifact } from "../device-support/android-project-builds.js";
import { RemoteAccessError } from "./errors.js";
import type { PhoneTaskCollaboration, PhoneTaskCollaborationPrincipal } from "./phone-task-collaboration.js";

const storageQuotaBytes = 4 * REMOTE_DEVICE_ARTIFACT_MAX_BYTES;
const blobPattern = /^[a-f0-9-]{36}\.artifact$/u;

interface StagedArtifact {
  readonly blobId: string;
  readonly sizeBytes: number;
  readonly digest: string;
}

type SignArtifact = (input: Uint8Array) => string;
type VerifyArtifact = (input: Uint8Array, signature: string) => boolean;
type OfferContext = {
  readonly currentPrincipal: () => PhoneTaskCollaborationPrincipal | undefined;
  readonly now: () => string;
  readonly sign: SignArtifact;
};
type FileOfferInput = RemoteDeviceArtifactOfferInputV1 & {
  readonly name: string;
  readonly sizeBytes: number;
  readonly build?: { readonly jobId: string; readonly digest: string };
};

export class PhoneTaskArtifacts {
  private uploading = false;

  constructor(
    private readonly store: SqliteDeviceDeveloperStore,
    private readonly collaboration: PhoneTaskCollaboration,
    private readonly directory: string,
    private readonly androidApks?: AndroidApkLibrary,
  ) {}

  get buildSharingEnabled(): boolean {
    return this.androidApks !== undefined;
  }

  listForPc(principal: PhoneTaskCollaborationPrincipal, input: Pick<RemoteDeviceArtifactOfferInputV1, "shareId" | "expectedRevision">, now: string) {
    return this.list(this.collaboration.currentShare(principal, input, now));
  }

  listBuildsForPc(
    principal: PhoneTaskCollaborationPrincipal, input: Pick<RemoteDeviceArtifactOfferInputV1, "shareId" | "expectedRevision">, now: string,
  ): readonly RemoteDeviceBuildArtifactSummaryV1[] {
    this.collaboration.currentShare(principal, input, now);
    if (!this.androidApks) return [];
    return this.store.listCompletedBuildJobIds(principal.workspaceId, 20).flatMap(buildJobId => {
      const retained = readProjectBuildArtifact(this.store, principal.workspaceId, buildJobId);
      return retained ? [{
        buildJobId, buildId: retained.build.buildId, name: retained.build.fileName, packageId: retained.packageId,
        versionCode: retained.versionCode, digest: retained.artifact.digest, builtAt: retained.artifact.createdAt,
      }] : [];
    });
  }

  async offerFromPc(
    initialPrincipal: PhoneTaskCollaborationPrincipal,
    input: FileOfferInput,
    source: Readable,
    context: OfferContext,
  ): Promise<RemoteDeviceArtifactOfferV1> {
    if (!isRemoteDeviceArtifactName(input.name) || Buffer.byteLength(input.name) > 320) {
      throw new RemoteAccessError("binding_changed", "Choose an artifact with a valid file name.");
    }
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > REMOTE_DEVICE_ARTIFACT_MAX_BYTES) {
      throw new RemoteAccessError("payload_too_large", "Artifact size is outside the allowed range.");
    }
    this.collaboration.currentShare(initialPrincipal, input, context.now());
    const isApk = isAndroidApkFileName(input.name);
    if (isApk && !this.androidApks) {
      throw new RemoteAccessError("pc_unavailable", "Configure Android APK tools on this PC before sharing an APK.");
    }
    if (this.uploading) throw new RemoteAccessError("rate_limited", "The PC is already staging an artifact.", true);
    this.uploading = true;
    let staged: StagedArtifact | undefined;
    let retained = false;
    try {
      staged = await this.stage(source, input.sizeBytes);
      if (input.build && input.build.digest !== staged.digest) {
        throw new RemoteAccessError("binding_changed", "The project build APK changed.");
      }
      let androidApk: AndroidApkIdentityV1 | undefined;
      if (isApk) {
        const verified = await this.androidApks!.verifyStaged(this.blobPath(staged.blobId), staged.digest);
        androidApk = { packageId: verified.packageId, ...verified.androidApk };
      }
      const now = context.now();
      const principal = context.currentPrincipal();
      if (!principal) throw new RemoteAccessError("binding_changed", "The phone pairing changed during the upload.");
      const published = this.publish(principal, input, staged, now, context.sign, androidApk);
      retained = published.retained;
      return published.offer;
    } finally {
      if (staged && !retained) await rm(this.blobPath(staged.blobId), { force: true }).catch(() => undefined);
      this.uploading = false;
    }
  }

  async offerFromBuild(principal: PhoneTaskCollaborationPrincipal, input: RemoteDeviceArtifactBuildOfferInputV1, context: OfferContext) {
    this.collaboration.currentShare(principal, input, context.now());
    const { buildJobId, ...offer } = input;
    const retained = readProjectBuildArtifact(this.store, principal.workspaceId, buildJobId);
    if (!this.androidApks || !retained) throw new RemoteAccessError("pc_unavailable", "The selected project build did not retain a verified APK.");
    return await this.androidApks.withApk(retained.artifact.digest, AbortSignal.timeout(30_000), async (source, sizeBytes) => {
      if (sizeBytes !== retained.artifact.sizeBytes) throw new RemoteAccessError("binding_changed", "The project build APK changed.");
      return await this.offerFromPc(principal, {
        ...offer, name: retained.build.fileName, sizeBytes, build: { jobId: buildJobId, digest: retained.artifact.digest },
      }, source, context);
    });
  }

  async fromPhone(
    principal: PhoneTaskCollaborationPrincipal, command: RemoteDeviceArtifactCommandV1,
    authority: {
      readonly now: () => string;
      readonly sign: SignArtifact;
      readonly verifyReceipt: VerifyArtifact;
      readonly assertCurrent: () => void;
      readonly supportsApkIdentity: boolean;
    },
  ): Promise<RemoteDeviceArtifactResultV1> {
    if (command.workspaceId !== principal.workspaceId) {
      throw new RemoteAccessError("workspace_not_allowed", "This artifact belongs to another workspace.");
    }
    const now = authority.now();
    const share = this.collaboration.currentShare(principal, command, now);
    const common = { kind: "device_artifact", shareId: share.shareId, revision: share.revision } as const;
    const { action } = command;
    if (action.kind === "list") return { ...common, operation: "list", offers: this.list(share, authority.supportsApkIdentity) };

    const proposal = this.requireProposal(share, action.proposalId);
    const offer = this.offer(proposal);
    const { manifest } = offer;
    if (manifest.androidApk && !authority.supportsApkIdentity) {
      throw new RemoteAccessError("capability_not_allowed", "Update Ling Mobile to receive verified APKs.");
    }
    if (action.kind === "decide") {
      return this.store.withWriteTransaction(() => {
        if (proposal.status !== "proposed" && proposal.status !== action.decision) {
          throw new RemoteAccessError("idempotency_conflict", "This artifact's decision has already been recorded.");
        }
        const saved = proposal.status === "proposed" ? this.store.saveProposal({ ...proposal, status: action.decision }) : proposal;
        return { ...common, operation: "decide", offer: this.offer(saved) };
      });
    }

    if (proposal.status !== "accepted") throw new RemoteAccessError("capability_not_allowed", "The phone must accept the artifact first.");
    if (action.kind === "receipt") {
      const { receipt } = action;
      const verifiedAt = Date.parse(receipt.verifiedAt);
      if (receipt.digest !== manifest.digest || verifiedAt > Date.parse(now) + REMOTE_PROTOCOL_LIMITS.maxClockSkewMs
        || verifiedAt < Date.parse(proposal.createdAt) - REMOTE_PROTOCOL_LIMITS.maxClockSkewMs || receipt.verifiedAt >= manifest.expiresAt
        || !!receipt.apkVerification !== !!manifest.androidApk
        || !authority.verifyReceipt(deviceArtifactReceiptBytes(manifest, receipt), receipt.signature)) {
        throw new RemoteAccessError("signature_invalid", "Artifact verification receipt is outside the current offer.");
      }
      const saved = this.store.savePhoneArtifactReceipt(proposal.proposalId, receipt);
      return { ...common, operation: "receipt", offer: { ...offer, receipt: saved } };
    }
    const bytes = await this.readChunk(this.readPayload(proposal).blobId, manifest, action.index);
    authority.assertCurrent();
    this.collaboration.currentShare(principal, command, authority.now());
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    return { ...common, operation: "chunk", proposalId: proposal.proposalId, chunk: {
      index: action.index, digest, bytes: bytes.toString("base64url"), signature: authority.sign(deviceArtifactChunkBytes(manifest, action.index, digest)),
    } };
  }

  private async stage(source: Readable, sizeBytes: number): Promise<StagedArtifact> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const files = await readdir(this.directory, { withFileTypes: true });
    let usedBytes = 0;
    for (const file of files) {
      if (!file.isFile() || !blobPattern.test(file.name)) continue;
      const path = this.blobPath(file.name);
      const stat = await lstat(path);
      // Uploads finish before their share expires. Leave space for reconnect and retries.
      if (stat.mtimeMs + REMOTE_DEVICE_COLLABORATION_MAX_MS * 2 < Date.now()) await rm(path, { force: true });
      else usedBytes += stat.size;
    }
    if (usedBytes + sizeBytes > storageQuotaBytes) throw new RemoteAccessError("rate_limited", "The PC artifact storage quota has been reached.", true);
    const blobId = randomUUID() + ".artifact";
    const path = this.blobPath(blobId);
    const hash = createHash("sha256");
    let count = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        count += chunk.length;
        if (count > sizeBytes) return callback(new Error("Artifact length exceeded"));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(source, meter, createWriteStream(path, { flags: "wx", mode: 0o600, flush: true }), { signal: AbortSignal.timeout(180_000) });
      if (count !== sizeBytes) throw new Error("Artifact length differed from the upload");
      return { blobId, sizeBytes, digest: `sha256:${hash.digest("hex")}` };
    } catch {
      await rm(path, { force: true }).catch(() => undefined);
      throw new RemoteAccessError("pc_unavailable", "The PC could not stage the selected artifact.", true);
    }
  }

  private publish(
    principal: PhoneTaskCollaborationPrincipal, input: FileOfferInput,
    artifact: StagedArtifact, now: string, sign: SignArtifact, androidApk?: AndroidApkIdentityV1,
  ): { readonly offer: RemoteDeviceArtifactOfferV1; readonly retained: boolean } {
    return this.store.withWriteTransaction(() => {
      const share = this.collaboration.currentShare(principal, input, now);
      const { projection } = share;
      const manifest: RemoteDeviceArtifactManifestV1 = {
        version: 1, gatewayId: principal.gatewayId, mobileDeviceId: principal.deviceId, deviceEpoch: principal.deviceEpoch,
        workspaceId: principal.workspaceId, workspaceBindingId: principal.workspaceBindingId, policyVersion: principal.policyVersion,
        shareId: share.shareId, revision: share.revision, proposalId: input.proposalId, taskId: projection.taskId, ownerId: projection.ownerId,
        projectionDigest: phoneTaskProjectionDigest(projection),
        targetDeviceId: projection.targetDeviceId, attemptId: projection.attempt.attemptId, connectionRevision: projection.attempt.connectionRevision,
        name: input.name, sizeBytes: artifact.sizeBytes, digest: artifact.digest, chunkBytes: REMOTE_DEVICE_ARTIFACT_CHUNK_BYTES, expiresAt: share.expiresAt,
        ...(androidApk ? { androidApk } : {}),
      };
      if (this.store.getProposal(input.proposalId)) {
        const previous = this.requireProposal(share, input.proposalId);
        const offer = this.offer(previous);
        if (offer.manifest.digest !== manifest.digest || offer.manifest.sizeBytes !== manifest.sizeBytes || offer.manifest.name !== manifest.name
          || !isDeepStrictEqual(offer.manifest.androidApk, manifest.androidApk) || this.readPayload(previous).buildJobId !== input.build?.jobId) {
          throw new RemoteAccessError("idempotency_conflict", "The proposal already refers to another artifact.");
        }
        return { offer, retained: false };
      }
      if (share.proposalIds.length >= REMOTE_DEVICE_COLLABORATION_MAX_PROPOSALS) {
        throw new RemoteAccessError("rate_limited", "The proposal limit for this task revision has been reached.");
      }
      const payload = { manifest: { ...manifest }, signature: sign(deviceArtifactManifestBytes(manifest)), blobId: artifact.blobId,
        ...(input.build ? { buildJobId: input.build.jobId } : {}) };
      const proposal = this.store.saveProposal({
        proposalId: input.proposalId, taskId: projection.taskId, ownerKind: "mobile", ownerId: projection.ownerId,
        proposerKind: "daemon", proposerId: principal.gatewayId, targetDeviceId: projection.targetDeviceId, kind: "artifact",
        payload, payloadDigest: digestCollaborationPayload(payload), baseRevision: `${share.shareId}:${share.revision}`,
        createdAt: now, expiresAt: share.expiresAt, status: "proposed",
      });
      this.store.savePhoneTaskShare({ ...share, proposalIds: [...share.proposalIds, proposal.proposalId] });
      return { offer: this.offer(proposal), retained: true };
    });
  }

  private async readChunk(blobId: string, manifest: RemoteDeviceArtifactManifestV1, index: number): Promise<Buffer> {
    const offset = index * manifest.chunkBytes;
    if (offset >= manifest.sizeBytes) throw new RemoteAccessError("binding_changed", "The chunk is outside this artifact.");
    const bytes = Buffer.alloc(Math.min(manifest.chunkBytes, manifest.sizeBytes - offset));
    const file = await open(this.blobPath(blobId), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined);
    if (!file) throw new RemoteAccessError("pc_unavailable", "The PC no longer has the staged artifact.", true);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== manifest.sizeBytes) throw new Error("staged size changed");
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
      if (bytesRead !== bytes.length) throw new Error("incomplete artifact read");
      return bytes;
    } catch {
      throw new RemoteAccessError("pc_unavailable", "The staged artifact is unavailable.", true);
    } finally {
      await file.close();
    }
  }

  private list(share: PhoneTaskShareRecord, supportsApkIdentity = true): readonly RemoteDeviceArtifactOfferV1[] {
    return share.proposalIds.flatMap(id => {
      const proposal = this.store.getProposal(id);
      return proposal?.kind === "artifact" && proposal.status !== "expired" ? [this.offer(proposal)] : [];
    }).filter(offer => supportsApkIdentity || !offer.manifest.androidApk);
  }

  private requireProposal(share: PhoneTaskShareRecord, proposalId: string): DeviceCollaborationProposalV1 {
    const proposal = share.proposalIds.includes(proposalId) && this.store.getProposal(proposalId);
    if (!proposal || proposal.kind !== "artifact" || proposal.baseRevision !== `${share.shareId}:${share.revision}` || proposal.status === "expired") {
      throw new RemoteAccessError("binding_changed", "The artifact is outside the current share.");
    }
    return proposal;
  }

  private offer(proposal: DeviceCollaborationProposalV1): RemoteDeviceArtifactOfferV1 {
    const { manifest, signature } = this.readPayload(proposal);
    const receipt = this.store.getPhoneArtifactReceipt(proposal.proposalId);
    return validateDeviceArtifactOffer({ manifest, signature, status: proposal.status, ...(receipt ? { receipt } : {}) }, "$.offer");
  }

  private readPayload({ payload }: DeviceCollaborationProposalV1) {
    if (!payload || typeof payload !== "object" || !("blobId" in payload) || typeof payload.blobId !== "string"
      || !("manifest" in payload) || !("signature" in payload)) throw new Error("Invalid stored artifact proposal");
    return { manifest: payload.manifest, signature: payload.signature, blobId: payload.blobId,
      buildJobId: "buildJobId" in payload ? payload.buildJobId : undefined };
  }

  private blobPath(blobId: string): string {
    if (!blobPattern.test(blobId)) throw new Error("Invalid artifact storage identity");
    return join(this.directory, blobId);
  }
}
