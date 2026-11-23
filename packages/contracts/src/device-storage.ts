export type DeviceStorageScope = "all" | "current";
export type DeviceStorageCategory = "conversations" | "worktrees" | "plugins" | "browser" | "other";
export type DeviceStorageStatus = "complete" | "scanning" | "partial" | "unavailable";
export interface DeviceStorageCategorySize {
  readonly category: DeviceStorageCategory;
  readonly knownBytes: number;
  readonly status: DeviceStorageStatus;
  readonly reason?: "cancelled" | "deadline" | "entry_limit" | "unavailable_path" | "read_error" | "browser_profile_unavailable";
}
export interface DeviceStorageSnapshot {
  readonly measurement: "logical_file_bytes";
  readonly scope: DeviceStorageScope;
  readonly scannedAt: string;
  readonly complete: boolean;
  readonly knownBytes: number;
  readonly categories: readonly DeviceStorageCategorySize[];
}
export interface DeviceStorageScanJob {
  readonly id: string;
  readonly status: "scanning" | "complete" | "partial" | "cancelled";
  readonly snapshot?: DeviceStorageSnapshot;
}
