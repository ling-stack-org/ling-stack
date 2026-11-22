import type { RemoteDeviceArtifactManifestV1, RemoteDeviceArtifactOfferV1, RemotePhoneTaskProjectionV1 } from "@ling-stack/contracts";
import type { RemoteSessionClient } from "@ling-stack/remote-client";
import { deviceArtifactManifestBytes, encodeBase64Url, phoneTaskProjectionDigest, sha256, validateDeviceArtifactOffer } from "@ling-stack/remote-protocol";
import type { MobileStorageLike } from "./journal.js";

export type PhoneTaskArtifactPeer = Pick<RemoteSessionClient,
  "listDeviceArtifacts" | "decideDeviceArtifact" | "readDeviceArtifactChunk" | "confirmDeviceArtifactReceived">;

export interface PhoneTaskArtifactFile {
  size(): Promise<number>;
  append(offset: number, bytes: Uint8Array): Promise<void>;
  digest(): Promise<string>;
  reset(): Promise<void>;
  seal(): Promise<void>;
  export(): Promise<void>;
}

export type OpenPhoneTaskArtifactFile = (id: string, name: string) => PhoneTaskArtifactFile;

export interface SavedPhoneTaskArtifact {
  readonly fileId: string;
  readonly offer: RemoteDeviceArtifactOfferV1;
  readonly verifiedAt: string;
}

export function createPhoneTaskArtifactReceiver(options: {
  readonly ownerId: string;
  readonly storage: MobileStorageLike;
  readonly openFile: OpenPhoneTaskArtifactFile;
  readonly foreground: () => boolean;
  readonly now: () => string;
  readonly readProjection: (taskId: string) => Promise<RemotePhoneTaskProjectionV1 | undefined>;
}) {
  const activeTasks = new Set<string>();
  const journalKey = (taskId: string) => `ling:phone-task-artifacts:v1:${options.ownerId}:${taskId}`;
  const listSaved = async (taskId: string): Promise<readonly SavedPhoneTaskArtifact[]> => {
    const raw = await options.storage.getItem(journalKey(taskId));
    if (raw === null) return [];
    const stored: unknown = JSON.parse(raw);
    if (!Array.isArray(stored)) throw new Error("phone_task_artifact_journal_invalid");
    return stored.map((value: unknown) => {
      if (!value || typeof value !== "object" || !("offer" in value) || !("verifiedAt" in value)
        || typeof value.verifiedAt !== "string" || !Number.isFinite(Date.parse(value.verifiedAt))) {
        throw new Error("phone_task_artifact_journal_invalid");
      }
      const offer = validateDeviceArtifactOffer(value.offer, "$.offer");
      if (offer.status !== "accepted" || offer.manifest.ownerId !== options.ownerId || offer.manifest.taskId !== taskId) {
        throw new Error("phone_task_artifact_binding_changed");
      }
      return { fileId: artifactFileId(offer.manifest), offer, verifiedAt: value.verifiedAt };
    });
  };

  async function assertProjection(manifest: RemoteDeviceArtifactManifestV1): Promise<void> {
    const projection = await options.readProjection(manifest.taskId);
    if (!projection || projection.ownerId !== options.ownerId || projection.ownerId !== manifest.ownerId
      || projection.targetDeviceId !== manifest.targetDeviceId || phoneTaskProjectionDigest(projection) !== manifest.projectionDigest
      || projection.attempt.attemptId !== manifest.attemptId || projection.attempt.connectionRevision !== manifest.connectionRevision
      || manifest.expiresAt <= options.now()) throw new Error("phone_task_artifact_binding_changed");
  }

  function assertForeground(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (!options.foreground()) throw new Error("phone_task_artifact_paused");
  }

  return {
    listSaved,
    async decide(offer: RemoteDeviceArtifactOfferV1, decision: "accepted" | "rejected", peer: PhoneTaskArtifactPeer) {
      await assertProjection(offer.manifest);
      assertForeground();
      return await peer.decideDeviceArtifact(offer, decision);
    },
    async receive(input: {
      readonly offer: RemoteDeviceArtifactOfferV1;
      readonly peer: PhoneTaskArtifactPeer;
      readonly onProgress?: (received: number, total: number) => void;
      readonly signal?: AbortSignal;
    }): Promise<RemoteDeviceArtifactOfferV1> {
      const { peer, onProgress, signal } = input;
      const { manifest } = input.offer;
      if (input.offer.status !== "accepted" || activeTasks.has(manifest.taskId)) throw new Error("phone_task_artifact_unavailable");
      activeTasks.add(manifest.taskId);
      try {
        await assertProjection(manifest);
        assertForeground(signal);
        const offer = (await peer.listDeviceArtifacts(manifest.shareId, manifest.revision)).find(item =>
          item.signature === input.offer.signature && item.manifest.proposalId === manifest.proposalId
          && artifactFileId(item.manifest) === artifactFileId(manifest) && item.status === "accepted");
        if (!offer) throw new Error("phone_task_artifact_binding_changed");
        assertForeground(signal);
        const fileId = artifactFileId(manifest);
        const file = options.openFile(fileId, manifest.name);
        let offset = await file.size();
        if (offset > manifest.sizeBytes || (offset !== manifest.sizeBytes && offset % manifest.chunkBytes !== 0)) {
          await file.reset();
          offset = 0;
        }
        onProgress?.(offset, manifest.sizeBytes);
        while (offset < manifest.sizeBytes) {
          assertForeground(signal);
          const index = offset / manifest.chunkBytes;
          const bytes = await peer.readDeviceArtifactChunk(manifest, index).catch(async error => {
            if (!(error instanceof Error) || !error.message.startsWith("rate_limited:")) throw error;
            await new Promise(resolve => setTimeout(resolve, 1_050));
            assertForeground(signal);
            return await peer.readDeviceArtifactChunk(manifest, index);
          });
          assertForeground(signal);
          if (bytes.length !== Math.min(manifest.chunkBytes, manifest.sizeBytes - offset)) throw new Error("phone_task_artifact_chunk_invalid");
          await file.append(offset, bytes);
          offset += bytes.length;
          onProgress?.(offset, manifest.sizeBytes);
        }
        const digest = await file.digest();
        if (digest !== manifest.digest) {
          await file.reset();
          throw new Error("phone_task_artifact_digest_mismatch");
        }
        await assertProjection(manifest);
        assertForeground(signal);
        await file.seal();
        const previous = await listSaved(manifest.taskId);
        const verifiedAt = previous.find(artifact => artifact.fileId === fileId)?.verifiedAt ?? options.now();
        async function remember(received: RemoteDeviceArtifactOfferV1) {
          await options.storage.setItem(journalKey(manifest.taskId), JSON.stringify([
            ...previous.filter(artifact => artifact.fileId !== fileId), { offer: received, verifiedAt },
          ]));
        }
        await remember(offer);
        const received = await peer.confirmDeviceArtifactReceived(offer, digest);
        await remember(received);
        return received;
      } finally {
        activeTasks.delete(manifest.taskId);
      }
    },
    async export(taskId: string, fileId: string): Promise<void> {
      const artifact = (await listSaved(taskId)).find(item => item.fileId === fileId);
      if (!artifact) throw new Error("phone_task_artifact_unavailable");
      const { manifest } = artifact.offer;
      const file = options.openFile(fileId, manifest.name);
      if (await file.size() !== manifest.sizeBytes || await file.digest() !== manifest.digest) throw new Error("phone_task_artifact_digest_mismatch");
      assertForeground();
      await file.export();
    },
  };
}

function artifactFileId(manifest: RemoteDeviceArtifactManifestV1): string {
  return encodeBase64Url(sha256(deviceArtifactManifestBytes(manifest)));
}
