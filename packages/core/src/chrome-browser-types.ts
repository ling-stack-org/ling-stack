export interface ChromeBrowserCredentialRecord {
  readonly workspaceId: string;
  readonly pluginId: string;
  readonly extensionId: string;
  readonly credentialHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt?: string;
}

export interface UpsertChromeBrowserCredentialInput {
  readonly workspaceId: string;
  readonly pluginId: string;
  readonly extensionId: string;
  readonly credentialHash: string;
}
