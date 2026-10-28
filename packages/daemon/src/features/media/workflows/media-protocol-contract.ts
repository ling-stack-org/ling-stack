import type { MediaWorkflowConnection } from "@ling-stack/core";

/** Stable API error for attempts to create new work through the historical protocol. */
export const LEGACY_MEDIA_PROTOCOL_REMOVED_CODE = "legacy_media_protocol_removed";
export const MEDIA_PROTOCOL_UNPREPARED_CODE = "media_protocol_unprepared";

export class MediaWorkflowProtocolCompatibilityError extends Error {
  readonly code: typeof LEGACY_MEDIA_PROTOCOL_REMOVED_CODE | typeof MEDIA_PROTOCOL_UNPREPARED_CODE;

  constructor(code: typeof LEGACY_MEDIA_PROTOCOL_REMOVED_CODE | typeof MEDIA_PROTOCOL_UNPREPARED_CODE, message: string) {
    super(message);
    this.name = "MediaWorkflowProtocolCompatibilityError";
    this.code = code;
  }
}
/**
 * The health result is the effective protocol for an auto-configured connection.
 * A configured value is only used as a fallback for connections that have not
 * published a health result yet. Legacy is intentionally still representable
 * here so historical handles can be decoded and polled.
 */
export function effectiveMediaWorkflowProtocol(
  connection: Pick<MediaWorkflowConnection, "protocolVariant" | "health">,
): "jobs_v1" | "prompt_legacy" | undefined {
  return connection.health?.protocolVariant ?? (
    connection.protocolVariant === "auto" ? undefined : connection.protocolVariant
  );
}

/** Guard the creation of a new task. Existing legacy handles must bypass this. */
export function assertCurrentMediaWorkflowProtocol(
  connection: Pick<MediaWorkflowConnection, "protocolVariant" | "health">,
): "jobs_v1" {
  const protocol = effectiveMediaWorkflowProtocol(connection);
  if (protocol === "prompt_legacy") {
    throw new MediaWorkflowProtocolCompatibilityError(
      LEGACY_MEDIA_PROTOCOL_REMOVED_CODE,
      "当前 ComfyUI 仅提供历史 Prompt/History 协议；该协议只能读取已有任务，请切换到 Jobs API 后再创建新任务。",
    );
  }
  if (protocol !== "jobs_v1") {
    throw new MediaWorkflowProtocolCompatibilityError(
      MEDIA_PROTOCOL_UNPREPARED_CODE,
      "ComfyUI 连接尚未完成 Jobs API 检查，不能创建新的媒体任务。",
    );
  }
  return protocol;
}
