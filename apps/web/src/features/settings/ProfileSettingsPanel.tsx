import { UserRound } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { UserProfile } from "../../types.js";
import { ProfilePage } from "../profile/ProfilePage.js";

export function ProfileSettingsPanel({
  cwd,
  onProfileChange,
}: {
  readonly cwd: string;
  readonly onProfileChange?: (profile: UserProfile) => void;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <div className="settings-section-stack">
      <section className="panel settings-panel account-profile-settings-panel" aria-labelledby="account-profile-settings-title">
        <div className="panel-title">
          <UserRound size={18} />
          <h2 id="account-profile-settings-title">{t("Profile identity")}</h2>
        </div>
        <ProfilePage cwd={cwd} onProfileChange={onProfileChange} />
      </section>
    </div>
  );
}
