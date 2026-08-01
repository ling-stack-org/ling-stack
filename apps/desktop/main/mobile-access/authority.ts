import { createHash, createHmac } from "node:crypto";

const AUTHORITY_DOMAIN = "ling-mobile-access-management-v1";

export function deriveMobileAccessManagementCapability(desktopBridgeToken: string): string {
  if (!desktopBridgeToken.trim()) {
    throw new Error("desktop_bridge_token_required_for_mobile_access");
  }
  return createHmac("sha256", desktopBridgeToken).update(AUTHORITY_DOMAIN, "utf8").digest("base64url");
}

export function deriveMobileAccessCsrfToken(managementCapability: string): string {
  return createHash("sha256").update(`ling-mobile-csrf-v1:${managementCapability}`, "utf8").digest("base64url");
}
