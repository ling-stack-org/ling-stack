import type {
  RemoteDeviceCollaborationActionV1, RemoteDeviceCollaborationViewV1, RemotePhoneTaskProjectionV1,
} from "@ling-stack/contracts";
import { canonicalizeJson } from "@ling-stack/remote-protocol";
import type { MobileStorageLike } from "./journal.js";

export interface PhoneTaskCollaborationPeer {
  readonly scope: string;
  update(shareId: string, action: RemoteDeviceCollaborationActionV1): Promise<RemoteDeviceCollaborationViewV1>;
}

interface PhoneTaskShareLink {
  readonly shareId: string;
  readonly revision: number;
  readonly expiresAt: string;
  readonly revoked?: true;
}

type PhoneTaskCollaborationOperation =
  | { readonly kind: "share" | "sync" | "revoke" }
  | {
      readonly kind: "decide";
      readonly view: Extract<RemoteDeviceCollaborationViewV1, { readonly state: "active" }>;
      readonly proposalId: string;
      readonly decision: "accepted" | "rejected";
    };

export function createPhoneTaskCollaboration(options: {
  readonly storage: MobileStorageLike;
  readonly ownerId: string;
  readonly now: () => string;
  readonly randomId: (prefix: string) => string | Promise<string>;
  readonly readProjection: (taskId: string) => Promise<RemotePhoneTaskProjectionV1 | undefined>;
}) {
  let queue = Promise.resolve();
  return (taskId: string, peer: PhoneTaskCollaborationPeer, operation: PhoneTaskCollaborationOperation): Promise<RemoteDeviceCollaborationViewV1 | undefined> => {
    const result = queue.then(async () => {
      const key = `ling:phone-task-share:v1:${options.ownerId}:${encodeURIComponent(peer.scope)}:${taskId}`;
      const now = options.now();
      let link = readLink(await options.storage.getItem(key));
      const canReuse = link && !link.revoked && link.expiresAt > now;
      if (!canReuse && operation.kind !== "share") return undefined;

      if (operation.kind === "revoke" && link) {
        const view = await peer.update(link.shareId, { kind: "revoke" });
        await saveLink(options.storage, key, view);
        return view;
      }
      const projection = await options.readProjection(taskId);
      if (!projection) throw new Error("phone_task_evidence_unavailable");
      if (operation.kind === "decide" && link) {
        const { view, proposalId, decision } = operation;
        if (view.shareId !== link.shareId || view.revision !== link.revision
          || canonicalizeJson(view.projection) !== canonicalizeJson(projection)) throw new Error("phone_task_evidence_changed");
        const next = await peer.update(link.shareId, { kind: "decide", expectedRevision: view.revision, proposalId, decision });
        const receiptKey = `${key}:${link.shareId}:${proposalId}`;
        await options.storage.setItem(receiptKey, JSON.stringify({ revision: view.revision, proposalId, decision, recordedAt: options.now() }));
        return next;
      }
      if (!link || !canReuse) {
        link = {
          shareId: await options.randomId("phone_share"),
          revision: 0,
          expiresAt: new Date(Date.parse(now) + 30 * 60_000).toISOString(),
        };
        // Retain the request identity before sending so an interrupted publish can be recovered.
        await options.storage.setItem(key, JSON.stringify(link));
      }
      const { shareId, expiresAt } = link;
      let view: RemoteDeviceCollaborationViewV1;
      try {
        view = await peer.update(shareId, { kind: "publish", expectedRevision: link.revision, expiresAt, projection });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("resync_required:")) throw error;
        const current = await peer.update(shareId, { kind: "read" });
        if (current.state !== "active") {
          await saveLink(options.storage, key, current);
          return current;
        }
        if (current.projection.taskId !== taskId || current.projection.targetDeviceId !== projection.targetDeviceId
          || current.projection.ownerId !== projection.ownerId || current.expiresAt !== expiresAt) throw error;
        view = await peer.update(shareId, { kind: "publish", expectedRevision: current.revision, expiresAt, projection });
      }
      await saveLink(options.storage, key, view);
      return view;
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
}

function readLink(raw: string | null): PhoneTaskShareLink | undefined {
  if (raw === null) return undefined;
  const value = JSON.parse(raw) as Partial<PhoneTaskShareLink> | null;
  if (!value || typeof value.shareId !== "string" || !/^phone_share_[A-Za-z0-9_-]{16,64}$/u.test(value.shareId)
    || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
    || (value.revoked !== undefined && value.revoked !== true)) throw new Error("phone_task_share_link_invalid");
  return { shareId: value.shareId, revision: value.revision, expiresAt: value.expiresAt, revoked: value.revoked };
}

function saveLink(storage: MobileStorageLike, key: string, view: RemoteDeviceCollaborationViewV1): Promise<void> {
  const { shareId, revision, expiresAt, state } = view;
  return storage.setItem(key, JSON.stringify({ shareId, revision, expiresAt, ...(state === "revoked" ? { revoked: true } : {}) }));
}
