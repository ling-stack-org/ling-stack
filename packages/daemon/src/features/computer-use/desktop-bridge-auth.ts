import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const DESKTOP_BRIDGE_TOKEN_HEADER = "x-ling-desktop-bridge-token" as const;

export type DesktopBridgeTokenStatus = "accepted" | "unavailable" | "forbidden";

export function desktopBridgeTokenStatus(
  request: IncomingMessage,
  configuredToken: string | undefined,
): DesktopBridgeTokenStatus {
  if (!configuredToken) {
    return "unavailable";
  }
  return configuredTokenMatches(
    configuredToken,
    request.headers[DESKTOP_BRIDGE_TOKEN_HEADER],
  )
    ? "accepted"
    : "forbidden";
}

export function configuredTokenMatches(
  configuredToken: string | undefined,
  providedToken: string | readonly string[] | undefined,
): boolean {
  return typeof configuredToken === "string"
    && configuredToken.length > 0
    && typeof providedToken === "string"
    && safeTokenEquals(providedToken, configuredToken);
}

function safeTokenEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.byteLength === rightBuffer.byteLength
    && timingSafeEqual(leftBuffer, rightBuffer);
}
