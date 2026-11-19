import type { ManagedWorktreeListResponse, ManagedWorktreeOwnerKind } from "@ling-stack/contracts";

export interface DesktopWorktreeInitializationRequest {
  readonly cwd: string;
  readonly ownerKind: ManagedWorktreeOwnerKind;
  readonly ownerId: string;
  readonly locale?: string;
}
export interface DesktopWorktreeCapabilities {
  initialize(request: DesktopWorktreeInitializationRequest): Promise<ManagedWorktreeListResponse | undefined>;
}
