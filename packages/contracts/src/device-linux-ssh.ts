export interface LinuxSshReadResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type LinuxWifiObservationError =
  "wireless_tools_unavailable" | "wireless_interface_not_found" | "wifi_observation_failed";

export interface LinuxNetworkFacts {
  readonly connected: boolean;
  readonly routeAvailable?: boolean;
  readonly dnsNameResolved?: boolean;
  readonly wifiAssociated?: boolean;
  readonly linkError?: LinuxWifiObservationError;
}

export function isLinuxDnsProbeHostname(name: string): boolean {
  if (name.length > 253 || name.trim() !== name) return false;
  const labels = name.replace(/\.$/u, "").split(".");
  return labels.length > 1 && /^[a-z]/i.test(labels.at(-1) ?? "")
    && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

export async function readLinuxIpv4Evidence(addresses: LinuxSshReadResult, readRoute: () => Promise<LinuxSshReadResult>): Promise<{
  readonly connected: boolean;
  readonly routeAvailable?: boolean;
  readonly interfaceName?: string;
  readonly ipv4?: string;
}> {
  if (addresses.exitCode !== 0) throw new Error("Linux interface addresses are unavailable");
  const interfaces = ipRecords(addresses.stdout);
  const routeResult = await readRoute();
  const routes = routeResult.exitCode === 0 ? ipRecords(routeResult.stdout) : undefined;
  const route = routes?.find(item => typeof item.dev === "string"
    && !["unreachable", "prohibit", "blackhole", "throw"].includes(String(item.type)));
  const noRoute = routeResult.exitCode === 2 && /RTNETLINK answers: Network is unreachable/u.test(routeResult.stderr);

  const configured: { interfaceName: string; ipv4: string }[] = [];
  for (const iface of interfaces) {
    if (typeof iface.ifname !== "string" || iface.ifname === "lo" || !Array.isArray(iface.addr_info)) continue;
    for (const address of iface.addr_info.filter(isRecord)) {
      if (address.family === "inet" && address.scope === "global" && typeof address.local === "string" && isIpv4(address.local)) {
        configured.push({ interfaceName: iface.ifname, ipv4: address.local });
      }
    }
  }
  const address = route
    ? configured.find(item => item.interfaceName === route.dev && item.ipv4 === route.prefsrc)
      ?? configured.find(item => item.interfaceName === route.dev)
    : configured[0];
  return {
    connected: configured.length > 0,
    ...(routes || noRoute ? { routeAvailable: route !== undefined } : {}),
    ...(address ?? (typeof route?.dev === "string" ? { interfaceName: route.dev } : {})),
  };
}

export function selectLinuxWifiInterface(output: LinuxSshReadResult, preferred?: string):
  { readonly interfaceName: string } | { readonly linkError: LinuxWifiObservationError } {
  if (output.exitCode !== 0) {
    return { linkError: output.exitCode === 127 ? "wireless_tools_unavailable" : "wifi_observation_failed" };
  }
  const names = [...output.stdout.matchAll(/^[ \t]*Interface[ \t]+([a-zA-Z0-9_][a-zA-Z0-9_.-]{0,14})[ \t]*\r?$/gmu)]
    .map(match => match[1]!);
  const interfaceName = preferred && names.includes(preferred) ? preferred : names[0];
  return interfaceName ? { interfaceName } : { linkError: "wireless_interface_not_found" };
}

export function readLinuxWifiLink(link: LinuxSshReadResult): {
  readonly wifiAssociated?: boolean;
  readonly ssid?: string;
  readonly linkError?: LinuxWifiObservationError;
} {
  if (link.exitCode !== 0) return { linkError: "wifi_observation_failed" };
  if (/^\s*Not connected\.?\s*$/mu.test(link.stdout)) return { wifiAssociated: false };
  if (!/^\s*Connected to\s/u.test(link.stdout)) return { linkError: "wifi_observation_failed" };
  const ssid = /^\s*SSID:\s*([^\r\n]*)/mu.exec(link.stdout)?.[1]?.trim();
  return { wifiAssociated: true, ...(ssid ? { ssid } : {}) };
}

export function readLinuxDnsLookup(result: LinuxSshReadResult): boolean | undefined {
  if (result.exitCode === 2) return false;
  if (result.exitCode !== 0) return undefined;
  return result.stdout.split("\n").some(line => isIpv4(line.trim().split(/\s+/u)[0] ?? "")) ? true : undefined;
}

function isIpv4(value: string): boolean {
  const fields = value.split(".");
  return fields.length === 4 && fields.every(field => /^(?:0|[1-9]\d{0,2})$/u.test(field) && Number(field) <= 255);
}

function ipRecords(output: string): readonly Record<string, unknown>[] {
  try {
    const value: unknown = JSON.parse(output);
    if (Array.isArray(value) && value.every(isRecord)) return value;
  } catch {
    // Parse exceptions can contain device output.
  }
  throw new Error("Linux ip command returned invalid JSON");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
