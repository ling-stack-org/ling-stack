import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DEFAULT_WORKSPACE_ID, type RunStore } from "@ling-stack/core";
import type { ControlPlaneReplayWindow, LingAppServerEventSubject } from "@ling-stack/contracts";

const recordId = "event-log";
const cursorPattern = /^v1\.(0|[1-9]\d{0,15})\.([A-Za-z0-9_-]{43})$/u;

export interface AppServerReplayScope {
  issue(seq: number): string;
  read(cursor: unknown): number | undefined;
  eventId(workspaceId: string, seq: number): string;
}

export function loadAppServerReplayIdentity(store: RunStore, cwd: string, authToken: string | undefined) {
  const record = store.getAppServerState("replay_identity", recordId)
    ?? store.putAppServerState({
      kind: "replay_identity",
      recordId,
      expectedRevision: 0,
      payload: randomBytes(32).toString("hex"),
    }, new Date().toISOString())?.record
    ?? store.getAppServerState("replay_identity", recordId);
  if (typeof record?.payload !== "string" || !/^[a-f0-9]{64}$/u.test(record.payload)) {
    throw new Error("App Server replay identity is unavailable.");
  }
  const key = Buffer.from(record.payload, "hex");
  const digest = (...parts: readonly (string | undefined)[]) =>
    createHmac("sha256", key).update(JSON.stringify(parts)).digest("base64url");
  const storeIncarnation = digest("store", cwd);
  const authorizationEpoch = digest("authorization", cwd, authToken);
  const eventId = (workspaceId: string, seq: number) => `${workspaceId}:${storeIncarnation}:${seq}`;
  return {
    storeIncarnation,
    authorizationEpoch,
    eventId,
    scope(kind: LingAppServerEventSubject["kind"], id: string | undefined): AppServerReplayScope {
      const signature = (seq: string) => digest("cursor", storeIncarnation, authorizationEpoch, kind, id, seq);
      return {
        issue(seq: number): string {
          return `v1.${seq}.${signature(String(seq))}`;
        },
        read(cursor: unknown): number | undefined {
          if (cursor === undefined || cursor === 0 || cursor === "0") return 0;
          const match = typeof cursor === "string" && cursorPattern.exec(cursor);
          if (!match) return undefined;
          const seq = Number(match[1]);
          if (!Number.isSafeInteger(seq)) return undefined;
          return timingSafeEqual(Buffer.from(match[2]), Buffer.from(signature(match[1]))) ? seq : undefined;
        },
        eventId,
      };
    },
  };
}

export function unavailableAppServerReplayWindow(store: RunStore): ControlPlaneReplayWindow {
  const { latestSeq, replayFloorSeq } = store.getControlPlaneReplayState(DEFAULT_WORKSPACE_ID);
  return { disposition: "snapshot_required", reason: "cursor_unavailable",
    requestedAfterSeq: 0, replayFloorSeq, upperBoundSeq: latestSeq, nextAfterSeq: latestSeq };
}
