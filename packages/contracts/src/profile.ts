export interface UserProfile {
  readonly schemaVersion: 1;
  readonly displayName: string;
  readonly handle?: string;
  readonly avatarDataUrl?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateUserProfileRequest {
  readonly displayName?: string;
  readonly handle?: string | null;
  readonly avatarDataUrl?: string | null;
}

export interface UserProfileResponse {
  readonly cwd: string;
  readonly profile: UserProfile;
}
