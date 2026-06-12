import { isIP } from "node:net";

export interface LinkMaterializationPolicyDecision {
  readonly allowed: boolean;
  readonly reason?: "unsupported_protocol" | "local_or_private_host" | "unsafe_url";
}

export function decidePublicLinkMaterializationPolicy(rawUrl: string): LinkMaterializationPolicyDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "unsafe_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, reason: "unsupported_protocol" };
  }
  if (isLocalOrPrivateHost(url.hostname)) {
    return { allowed: false, reason: "local_or_private_host" };
  }
  return { allowed: true };
}

export function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1"
  ) {
    return true;
  }
  if (isIP(host) === 4) {
    const [a = 0, b = 0] = host.split(".").map((part) => Number.parseInt(part, 10));
    return a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }
  if (isIP(host) === 6) {
    return host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe80:");
  }
  return false;
}
