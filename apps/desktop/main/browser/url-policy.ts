import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parseDesktopBrowserUrl } from "@ling-stack/contracts";

export function isBrowserLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127\./u.test(host);
}

export function isBrowserPublicAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/gu, "").toLowerCase();
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a! < 224
      && !(a === 169 && b === 254) && !(a === 172 && b! >= 16 && b! <= 31)
      && !(a === 192 && (b === 168 || b === 0)) && !(a === 100 && b! >= 64 && b! <= 127)
      && !(a === 198 && (b === 18 || b === 19));
  }
  // IPv4-mapped, unspecified, multicast, unique-local and link-local ranges are excluded.
  return isIP(host) === 6 && /^[23]/u.test(host) && !host.startsWith("2001:db8:");
}

export async function assertBrowserNetworkUrl(value: string, input: {
  readonly allowedLoopbackOrigin?: string;
  readonly forbiddenOrigins: readonly string[];
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
}): Promise<void> {
  const normalized = value.replace(/^ws:/u, "http:").replace(/^wss:/u, "https:");
  const url = new URL(parseDesktopBrowserUrl(normalized));
  const forbidden = input.forbiddenOrigins.some(value => {
    const application = new URL(value);
    return application.origin === url.origin || (isBrowserLoopback(application.hostname) && isBrowserLoopback(url.hostname)
      && (application.port || (application.protocol === "https:" ? "443" : "80")) === (url.port || (url.protocol === "https:" ? "443" : "80")));
  });
  if (forbidden) throw new Error("browser_application_origin_forbidden");
  if (isBrowserLoopback(url.hostname)) {
    if (url.origin !== input.allowedLoopbackOrigin) throw new Error("browser_loopback_origin_forbidden");
    return;
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const addresses = isIP(host) ? [host] : await (input.resolveHost?.(host)
    ?? lookup(host, { all: true, verbatim: true }).then(entries => entries.map(entry => entry.address)));
  if (!addresses.length || addresses.some(address => !isBrowserPublicAddress(address))) throw new Error("browser_private_network_forbidden");
}
