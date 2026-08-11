import { AvatarInitial } from "./AvatarInitial.js";
import type { UserProfile } from "../../types.js";

export function UserProfileAvatar({
  profile,
  fallbackLabel = "You",
}: {
  readonly profile: UserProfile | undefined;
  readonly fallbackLabel?: string;
}): React.JSX.Element {
  if (profile?.avatarDataUrl) {
    return <img className="user-profile-avatar" src={profile.avatarDataUrl} alt="" />;
  }
  return <AvatarInitial label={initialFromName(profile?.displayName ?? fallbackLabel)} tone="gray" />;
}

function initialFromName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "U";
  }
  return [...trimmed][0]?.toUpperCase() ?? "U";
}
