import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { hostLocalNetworkResultLimitsV1 as limits, readHostCapabilityCallV1,
  type HostLocalInterfaceAddressV1, type HostLocalNetworkInfoResultV1 } from "@ling-stack/contracts";
import { isRecord } from "../../shared/validation.js";

interface CollectionOptions {
  readonly signal?: AbortSignal;
  /** Host dependency seam; never selected by model input or persisted as authority. */
  readonly readInterfaces?: () => unknown;
  readonly now?: () => Date;
}
const identity = { contractVersion: 1, capabilityId: "host.local_network_info" } as const;

/**
 * Host-side collection primitive. The dispatcher must validate current scope,
 * captured execution identity and an independent durable approval before calling.
 * No shell, external network, environment access or public-IP discovery occurs.
 */
export function collectHostLocalNetworkInfo(input: unknown, options: CollectionOptions = {}): HostLocalNetworkInfoResultV1 {
  options.signal?.throwIfAborted();
  let query;
  try {
    const call = readHostCapabilityCallV1("host_local_network_info", input);
    if (call.capabilityId !== identity.capabilityId) throw new Error("Unexpected capability");
    query = call.input;
  } catch {
    return { ...identity, status: "failed", code: "invalid_capability_input",
      message: "Local interface queries accept only family (all, IPv4 or IPv6) and includeLoopback. Public-IP discovery is not supported." };
  }
  try {
    const raw = (options.readInterfaces ?? networkInterfaces)();
    options.signal?.throwIfAborted();
    if (!isRecord(raw)) throw new Error("Invalid interface collection");
    const collectedAt = (options.now?.() ?? new Date()).toISOString();
    const addresses: HostLocalInterfaceAddressV1[] = [];
    const interfaces = new Set<string>();
    let truncated = false;
    outer: for (const name of Object.keys(raw).sort(compareText)) {
      const source = raw[name];
      if (source === undefined) continue;
      if (!Array.isArray(source)) throw new Error("Invalid interface records");
      const matching = source.map(entry => normalizeAddress(name, entry))
        .filter(entry => (query.family === "all" || entry.family === query.family) && (query.includeLoopback || !entry.internal))
        .sort((a, b) => compareText(a.family, b.family) || compareText(a.address, b.address) || Number(a.internal) - Number(b.internal));
      for (const entry of matching) {
        if (addresses.length >= limits.maxAddresses || !interfaces.has(name) && interfaces.size >= limits.maxInterfaces) {
          truncated = true; break outer;
        }
        const candidate = { ...identity, status: "succeeded", collectedAt, addresses: [...addresses, entry], truncated: false };
        // Keep complete address facts, never a partial interface name or IP. False
        // is one byte longer than true, so the final truncation flag still fits.
        if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > limits.maxBytes) { truncated = true; break outer; }
        addresses.push(entry);
        interfaces.add(name);
      }
    }
    options.signal?.throwIfAborted();
    return { ...identity, status: "succeeded", collectedAt, addresses, truncated };
  } catch {
    // Cancellation belongs to the Runner lifecycle, not a failed query receipt.
    options.signal?.throwIfAborted();
    return { ...identity, status: "failed", code: "host_capability_failed",
      message: "The Host could not collect valid local interface addresses. Retry the query or check Host access." };
  }
}

function normalizeAddress(interfaceName: string, value: unknown): HostLocalInterfaceAddressV1 {
  if (!interfaceName || !isRecord(value) || (value.family !== "IPv4" && value.family !== "IPv6")
    || typeof value.address !== "string" || typeof value.internal !== "boolean"
    || isIP(value.address) !== (value.family === "IPv4" ? 4 : 6)) throw new Error("Invalid interface address");
  // Explicit field selection excludes mac/netmask/cidr/scopeid and future OS fields.
  return { interfaceName, family: value.family, address: value.address, internal: value.internal };
}
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
