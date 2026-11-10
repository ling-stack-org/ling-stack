/** Hard output bounds, independent from smaller model/UI evidence projections. */
export const hostLocalNetworkResultLimitsV1 = Object.freeze({ maxInterfaces: 64, maxAddresses: 256, maxBytes: 32 * 1024 });

export interface HostLocalInterfaceAddressV1 {
  readonly interfaceName: string;
  readonly family: "IPv4" | "IPv6";
  readonly address: string;
  readonly internal: boolean;
}

export type HostLocalNetworkInfoResultV1 = {
  readonly contractVersion: 1;
  readonly capabilityId: "host.local_network_info";
} & (
  | { readonly status: "succeeded"; readonly collectedAt: string; readonly addresses: readonly HostLocalInterfaceAddressV1[]; readonly truncated: boolean }
  | { readonly status: "failed"; readonly code: "invalid_capability_input" | "host_capability_failed"; readonly message: string }
);
