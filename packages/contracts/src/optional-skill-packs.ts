export type OptionalSkillPackId = "gstack" | "superpowers";

export interface OptionalSkillPackView {
  readonly id: OptionalSkillPackId;
  readonly name: string;
  readonly upstreamUrl: string;
  readonly state: "not_installed" | "disabled" | "enabled" | "unavailable";
  readonly issue?: "missing_dependencies" | "incompatible_platform" | "invalid_resources";
  readonly version?: string;
  readonly skillCount?: number;
  readonly downloadBytes?: number;
  readonly retainedVersion?: string;
  readonly previousVersion?: string;
}

export interface OptionalSkillPackListResponse {
  readonly packs: readonly OptionalSkillPackView[];
}

export type OptionalSkillPackAction =
  | { readonly action: "install" | "enable" | "disable" | "uninstall" | "rollback" }
  | { readonly action: "connect"; readonly path: string; readonly expectedManifestChecksum?: string };
