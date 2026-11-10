import type { HostOperationSource } from "./host-operation-journal-types.js";
import type { HOST_OFFICE_LOCAL_PROTOCOL, HostOfficeFileIdentity, HostOfficeFileSnapshot, HostOfficeLocalMember } from "./host-office-local-types.js";

export interface HostOfficeLocalTerminalEffect {
  readonly ordinal: number;
  readonly effectId: string;
  readonly effectDigest: string;
  readonly enteredAt: string | null;
  readonly observation: { readonly artifactId: string; readonly digest: string } | null;
}
export interface HostOfficeLocalTerminalMember {
  readonly memberId: string;
  readonly role: HostOfficeLocalMember["role"];
  readonly path: string;
  readonly final: HostOfficeFileSnapshot | { readonly state: "directory"; readonly identity: HostOfficeFileIdentity }
    | { readonly state: "unobserved"; readonly errorCode: string };
  readonly observedAt: string;
  /** Read completion is closeReturnedAt, not the earlier member observedAt. */
  readonly readRef?: { readonly readId: string; readonly resourceLifetimeId: string; readonly completedAt: string };
}
interface HostOfficeLocalTerminalResourceBase {
  readonly memberId: string;
  readonly resourceLifetimeId: string;
  readonly identity?: HostOfficeFileIdentity;
  readonly identityObservedAt?: string;
}
export type HostOfficeLocalTerminalEffectResource = HostOfficeLocalTerminalResourceBase & {
  readonly origin: "effect";
  readonly openEffectId: string;
} & ({ readonly state: "retained" } | { readonly state: "unknown" | "closed"; readonly closeEffectId: string });
export type HostOfficeLocalTerminalReadResource = HostOfficeLocalTerminalResourceBase & {
  readonly origin: "member_read";
  readonly readId: string;
  readonly purpose: "refresh" | "final";
  readonly openCalledAt: string;
  readonly openReturnedAt: string;
} & ({ readonly state: "retained" } | { readonly state: "unknown"; readonly closeEnteredAt: string }
  | { readonly state: "closed"; readonly closeEnteredAt: string; readonly closeReturnedAt: string });
export type HostOfficeLocalTerminalResource = HostOfficeLocalTerminalEffectResource | HostOfficeLocalTerminalReadResource;
export interface HostOfficeLocalTerminalWorkspace {
  readonly final: { readonly state: "directory"; readonly identity: HostOfficeFileIdentity }
    | { readonly state: "unobserved"; readonly errorCode: string };
  readonly observedAt: string;
}

/** Host-captured complete terminal facts. Neither this manifest nor its persisted record grants safe authority. */
export interface HostOfficeLocalTerminalManifest {
  readonly schemaVersion: 1;
  readonly protocol: typeof HOST_OFFICE_LOCAL_PROTOCOL;
  readonly kind: "office_local_terminal_v1";
  readonly executionId: string;
  readonly executionIdentityDigest: string;
  readonly source: HostOperationSource;
  readonly preparedArtifactId: string;
  readonly preparedDigest: string;
  readonly outcome: "published" | "failed";
  readonly publicationEntered: boolean;
  readonly effects: readonly HostOfficeLocalTerminalEffect[];
  readonly members: readonly HostOfficeLocalTerminalMember[];
  readonly resources: readonly HostOfficeLocalTerminalResource[];
  readonly workspace: HostOfficeLocalTerminalWorkspace;
  readonly completedAt: string;
}
export interface SealHostOfficeLocalTerminalInput {
  readonly terminalArtifactId: string;
  readonly terminalDigest: string;
}
export interface HostOfficeLocalTerminalRecord extends HostOfficeLocalTerminalManifest {
  readonly terminalArtifactId: string;
  readonly terminalDigest: string;
  readonly effectSetDigest: string;
  readonly effectCount: number;
  readonly sealedAt: string;
}
