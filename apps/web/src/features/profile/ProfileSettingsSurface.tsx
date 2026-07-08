import { type ChangeEvent, type FormEvent, type RefObject } from "react";
import { Bot, Camera, Check, MessageSquare, RefreshCw, RotateCcw, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import { useI18n } from "../../i18n.js";

export type ActivityMode = "day" | "week" | "total";

export interface ProfileMetrics {
  readonly totalEstimatedTokens: number;
  readonly peakEstimatedTokens: number;
  readonly longestDurationMs: number;
  readonly currentStreakDays: number;
  readonly longestStreakDays: number;
  readonly sessionCount: number;
  readonly successRate: number;
  readonly topModel: string;
  readonly exploredSkillCount: number;
  readonly totalSkillCount: number;
  readonly topSkills: readonly { readonly id: string; readonly label: string; readonly count: number }[];
  readonly activityDays: ReadonlyMap<string, number>;
}

export interface ProfileActivityCalendar {
  readonly cells: readonly { readonly date: string; readonly value: number; readonly level: number }[];
  readonly monthLabels: readonly { readonly month: string; readonly column: number }[];
}

interface ProfileSettingsSurfaceProps {
  readonly displayName: string;
  readonly handle: string;
  readonly visibleHandle: string;
  readonly avatarDataUrl: string | undefined;
  readonly initials: string;
  readonly metrics: ProfileMetrics;
  readonly activity: ProfileActivityCalendar;
  readonly activityMode: ActivityMode;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly hasProfileChanges: boolean;
  readonly message: string;
  readonly fileInputRef: RefObject<HTMLInputElement>;
  readonly onRefresh: () => void;
  readonly onSave: (event?: FormEvent<HTMLFormElement>) => void;
  readonly onReset: () => void;
  readonly onAvatarChange: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onDisplayNameChange: (value: string) => void;
  readonly onHandleChange: (value: string) => void;
  readonly onActivityModeChange: (mode: ActivityMode) => void;
  readonly formatCompactNumber: (value: number) => string;
  readonly formatDuration: (value: number) => string;
}

export function ProfileSettingsSurface({
  displayName,
  handle,
  visibleHandle,
  avatarDataUrl,
  initials,
  metrics,
  activity,
  activityMode,
  loading,
  saving,
  hasProfileChanges,
  message,
  fileInputRef,
  onRefresh,
  onSave,
  onReset,
  onAvatarChange,
  onDisplayNameChange,
  onHandleChange,
  onActivityModeChange,
  formatCompactNumber,
  formatDuration,
}: ProfileSettingsSurfaceProps): JSX.Element {
  const { t } = useI18n();
  const resolvedName = displayName.trim() || "Ling User";
  const isSuccessMessage = message.includes(t("Saved")) || message.includes(t("Profile saved")) || message.includes(t("Avatar adjusted. Save to apply."));

  return (
    <div className="profile-settings-surface" aria-label={t("User profile")}>
      <header className="profile-settings-head">
        <div>
          <h1>{t("User profile")}</h1>
          <p>{t("Set the identity shown in channels, private chats, and approval records.")}</p>
        </div>
        <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={14} />
          <span>{loading ? t("Refreshing") : t("Refresh")}</span>
        </button>
      </header>

      <div className="profile-settings-primary-grid">
        <section className="profile-settings-card profile-identity-card" aria-label={t("Identity information")}>
          <div className="profile-settings-card-head">
            <span className="profile-settings-card-icon"><UserRound size={16} /></span>
            <div>
              <h2>{t("Identity information")}</h2>
              <p>{t("Only used for display in this local workspace.")}</p>
            </div>
          </div>

          <form className="profile-settings-form" onSubmit={onSave}>
            <div className="profile-settings-avatar-row">
              <button
                className={avatarDataUrl ? "profile-avatar-button profile-settings-avatar has-avatar" : "profile-avatar-button profile-settings-avatar"}
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label={t("Change avatar")}
                title={t("Change avatar")}
              >
                {avatarDataUrl ? <img src={avatarDataUrl} alt="" /> : <span>{initials}</span>}
                <span className="profile-avatar-edit"><Camera size={14} /></span>
              </button>
              <div>
                <strong>{resolvedName}</strong>
                <span>@{visibleHandle}</span>
                <button className="secondary-button compact-button" type="button" onClick={() => fileInputRef.current?.click()}>
                  {t("Change avatar")}
                </button>
              </div>
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onAvatarChange} />

            <div className="profile-settings-fields">
              <label>
                <span>{t("Display name")}</span>
                <input value={displayName} onChange={(event) => onDisplayNameChange(event.target.value)} maxLength={80} />
              </label>
              <label>
                <span>{t("Handle")}</span>
                <input value={handle} onChange={(event) => onHandleChange(event.target.value)} maxLength={48} placeholder="local-user" />
              </label>
            </div>

            <footer className="profile-settings-actions">
              {message ? <span className={isSuccessMessage ? "profile-inline-message ok" : "profile-inline-message"}>{message}</span> : <span />}
              <div>
                {hasProfileChanges ? (
                  <button className="secondary-button compact-button" type="button" onClick={onReset} disabled={saving}>
                    <RotateCcw size={14} />
                    <span>{t("Reset changes")}</span>
                  </button>
                ) : null}
                <button className="primary-button compact-button" type="submit" disabled={!hasProfileChanges || saving}>
                  {saving ? <RefreshCw size={14} /> : <Check size={14} />}
                  <span>{saving ? t("Saving") : t("Save profile")}</span>
                </button>
              </div>
            </footer>
          </form>
        </section>

        <ProfilePreviewCard displayName={resolvedName} visibleHandle={visibleHandle} avatarDataUrl={avatarDataUrl} initials={initials} />
      </div>

      <ProfileUsageSummary
        metrics={metrics}
        activity={activity}
        activityMode={activityMode}
        onActivityModeChange={onActivityModeChange}
        formatCompactNumber={formatCompactNumber}
        formatDuration={formatDuration}
      />
    </div>
  );
}

function ProfilePreviewCard({
  displayName,
  visibleHandle,
  avatarDataUrl,
  initials,
}: {
  readonly displayName: string;
  readonly visibleHandle: string;
  readonly avatarDataUrl: string | undefined;
  readonly initials: string;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="profile-settings-card profile-preview-card" aria-label={t("Display preview")}>
      <div className="profile-settings-card-head">
        <span className="profile-settings-card-icon"><MessageSquare size={16} /></span>
        <div>
          <h2>{t("Display preview")}</h2>
          <p>{t("These places use your avatar and display name.")}</p>
        </div>
      </div>
      <div className="profile-preview-message" aria-label={t("Profile display preview")}>
        <ProfilePreviewAvatar avatarDataUrl={avatarDataUrl} initials={initials} />
        <div>
          <header>
            <strong>{displayName}</strong>
            <span>@{visibleHandle}</span>
          </header>
          <p>{t("This identity appears in local messages, private chats, and approval records.")}</p>
        </div>
      </div>
      <div className="profile-preview-usage-list">
        <ProfilePreviewUsage icon={<MessageSquare size={14} />} label={t("Channel messages")} />
        <ProfilePreviewUsage icon={<Bot size={14} />} label={t("AI teammate private chat")} />
        <ProfilePreviewUsage icon={<ShieldCheck size={14} />} label={t("Approval records")} />
      </div>
    </section>
  );
}

function ProfilePreviewAvatar({ avatarDataUrl, initials }: { readonly avatarDataUrl: string | undefined; readonly initials: string }): JSX.Element {
  if (avatarDataUrl) {
    return <img className="profile-preview-avatar" src={avatarDataUrl} alt="" />;
  }
  return <span className="profile-preview-avatar profile-preview-avatar-fallback">{initials}</span>;
}

function ProfilePreviewUsage({ icon, label }: { readonly icon: JSX.Element; readonly label: string }): JSX.Element {
  return (
    <span>
      {icon}
      {label}
    </span>
  );
}

function ProfileUsageSummary({
  metrics,
  activity,
  activityMode,
  onActivityModeChange,
  formatCompactNumber,
  formatDuration,
}: {
  readonly metrics: ProfileMetrics;
  readonly activity: ProfileActivityCalendar;
  readonly activityMode: ActivityMode;
  readonly onActivityModeChange: (mode: ActivityMode) => void;
  readonly formatCompactNumber: (value: number) => string;
  readonly formatDuration: (value: number) => string;
}): JSX.Element {
  const { t } = useI18n();
  const hasActivity = metrics.sessionCount > 0 || metrics.totalEstimatedTokens > 0 || metrics.topSkills.length > 0;

  return (
    <section className="profile-settings-card profile-usage-card" aria-label={t("Usage summary")}>
      <div className="profile-settings-card-head split">
        <span className="profile-settings-card-icon"><Sparkles size={16} /></span>
        <div>
          <h2>{t("Usage summary")}</h2>
          <p>{t("Local activity, trends, and streaks stay here.")}</p>
        </div>
      </div>

      {hasActivity ? (
        <>
          <div className="profile-usage-summary-grid" aria-label={t("Profile usage summary")}>
            <ProfileUsageMetric label={t("Sessions")} value={String(metrics.sessionCount)} />
            <ProfileUsageMetric label={t("Task success rate")} value={`${metrics.successRate}%`} />
            <ProfileUsageMetric label={t("Top model")} value={metrics.topModel} />
            <ProfileUsageMetric label={t("Skills used")} value={String(metrics.exploredSkillCount)} />
          </div>
          <div className="profile-usage-meta-line">
            <span>{t("Estimated tokens")} <strong>{formatCompactNumber(metrics.totalEstimatedTokens)}</strong></span>
            <span>{t("Longest task")} <strong>{formatDuration(metrics.longestDurationMs)}</strong></span>
            <span>{t("Longest streak")} <strong>{t("{count} days", { count: metrics.longestStreakDays })}</strong></span>
          </div>
          <details className="profile-usage-details" open>
            <summary>{t("Usage insights")}</summary>
            <div className="profile-usage-details-body">
              <div className="profile-section-head">
                <h3>{t("Token activity")}</h3>
                <div className="profile-segmented" role="tablist" aria-label={t("Token activity range")}>
                  {([
                    ["day", t("Daily")],
                    ["week", t("Weekly")],
                    ["total", t("Cumulative")],
                  ] as const).map(([mode, label]) => (
                    <button key={mode} type="button" className={activityMode === mode ? "active" : ""} onClick={() => onActivityModeChange(mode)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="profile-activity-body">
                <div className="profile-heatmap" role="img" aria-label={t("Token activity heatmap for the past year")}>
                  <div className="profile-heatmap-grid">
                    {activity.cells.map((cell) => (
                      <span key={cell.date} className={`profile-heatmap-cell level-${cell.level}`} title={t("{date}: {value} estimated tokens", { date: cell.date, value: formatCompactNumber(cell.value) })} />
                    ))}
                  </div>
                  <div className="profile-heatmap-months" aria-hidden="true">
                    {activity.monthLabels.map((label) => <span key={`${label.month}-${label.column}`} style={{ gridColumn: label.column }}>{label.month}</span>)}
                  </div>
                </div>
              </div>
              <div className="profile-usage-streak-section">
                <h3>{t("Usage streak")}</h3>
                <div className="profile-usage-streak-grid">
                  <ProfileUsageMetric label={t("Current streak")} value={t("{count} days", { count: metrics.currentStreakDays })} />
                  <ProfileUsageMetric label={t("Longest streak")} value={t("{count} days", { count: metrics.longestStreakDays })} />
                  <ProfileUsageMetric label={t("Peak tokens")} value={formatCompactNumber(metrics.peakEstimatedTokens)} />
                </div>
              </div>
              <div className="profile-usage-skill-section">
                <h3>{t("Most used skills")}</h3>
                {metrics.topSkills.length > 0 ? (
                  <div className="profile-skill-list compact">
                    {metrics.topSkills.map((skill) => (
                      <div key={skill.id} className="profile-skill-row">
                        <span className="profile-skill-icon"><Sparkles size={14} /></span>
                        <strong>{skill.label}</strong>
                        <span>{t("{count} runs", { count: skill.count })}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="profile-empty">{t("No skill-backed runs yet.")}</p>
                )}
              </div>
            </div>
          </details>
        </>
      ) : (
        <p className="profile-usage-empty">{t("Not enough local activity yet.")}</p>
      )}
    </section>
  );
}

function ProfileUsageMetric({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return (
    <span className="profile-usage-metric">
      <small>{label}</small>
      <strong>{value}</strong>
    </span>
  );
}
