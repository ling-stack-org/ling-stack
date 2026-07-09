import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject } from "react";
import { Camera, Pencil, Sparkles } from "lucide-react";
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
  readonly visibleHandle: string;
  readonly avatarDataUrl: string | undefined;
  readonly initials: string;
  readonly metrics: ProfileMetrics;
  readonly activity: ProfileActivityCalendar;
  readonly activityMode: ActivityMode;
  readonly saving: boolean;
  readonly message: string;
  readonly fileInputRef: RefObject<HTMLInputElement>;
  readonly onAvatarChange: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onCommitDisplayName: (value: string) => void | Promise<void>;
  readonly onActivityModeChange: (mode: ActivityMode) => void;
  readonly formatCompactNumber: (value: number) => string;
  readonly formatDuration: (value: number) => string;
}

export function ProfileSettingsSurface({
  displayName,
  visibleHandle,
  avatarDataUrl,
  initials,
  metrics,
  activity,
  activityMode,
  saving,
  message,
  fileInputRef,
  onAvatarChange,
  onCommitDisplayName,
  onActivityModeChange,
  formatCompactNumber,
  formatDuration,
}: ProfileSettingsSurfaceProps): JSX.Element {
  const { t } = useI18n();
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const skipBlurCommitRef = useRef(false);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(displayName);
  const [toast, setToast] = useState<{ readonly message: string; readonly tone: "ok" | "danger" } | undefined>();
  const resolvedName = displayName.trim() || "Ling User";
  const statusMessage = saving ? t("Saving") : message;
  const isSuccessMessage = message.includes(t("Saved")) || message.includes(t("Profile saved"));
  const isOkStatus = saving || isSuccessMessage;

  useEffect(() => {
    if (!editingName) {
      setDraftName(displayName);
    }
  }, [displayName, editingName]);

  useEffect(() => {
    if (!editingName) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [editingName]);

  useEffect(() => {
    if (!statusMessage.trim()) {
      return;
    }
    setToast({ message: statusMessage, tone: isOkStatus ? "ok" : "danger" });
    const timeoutId = window.setTimeout(() => setToast(undefined), 3000);
    return () => window.clearTimeout(timeoutId);
  }, [isOkStatus, statusMessage]);

  function startNameEdit(): void {
    setDraftName(resolvedName);
    setEditingName(true);
  }

  function cancelNameEdit(): void {
    skipBlurCommitRef.current = true;
    setDraftName(displayName);
    setEditingName(false);
  }

  async function commitNameEdit(): Promise<void> {
    const nextName = draftName.trim();
    setEditingName(false);
    if (!nextName || nextName === resolvedName) {
      setDraftName(displayName);
      return;
    }
    await onCommitDisplayName(nextName);
  }

  function handleNameBlur(): void {
    if (skipBlurCommitRef.current) {
      skipBlurCommitRef.current = false;
      return;
    }
    void commitNameEdit();
  }

  function handleNameKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitNameEdit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelNameEdit();
    }
  }

  return (
    <div className="profile-settings-surface" aria-label={t("User profile")}>
      {toast ? (
        <div className={`profile-settings-tip ${toast.tone}`} role={toast.tone === "ok" ? "status" : "alert"} aria-live={toast.tone === "ok" ? "polite" : "assertive"}>
          {toast.message}
        </div>
      ) : null}

      <section className="profile-settings-section profile-settings-identity-block" aria-label={t("User profile")}>
        <button
          className={avatarDataUrl ? "profile-avatar-button profile-settings-avatar has-avatar" : "profile-avatar-button profile-settings-avatar"}
          type="button"
          onClick={() => fileInputRef.current?.click()}
          aria-label={t("Change avatar")}
          title={t("Change avatar")}
        >
          {avatarDataUrl ? <img src={avatarDataUrl} alt="" /> : <span>{initials}</span>}
          <span className="profile-avatar-edit"><Camera size={15} /></span>
        </button>
        <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onAvatarChange} />

        <div className="profile-settings-name-stack">
          {editingName ? (
            <input
              ref={nameInputRef}
              className="profile-settings-name-input"
              aria-label={t("Display name")}
              value={draftName}
              maxLength={80}
              disabled={saving}
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={handleNameBlur}
              onKeyDown={handleNameKeyDown}
            />
          ) : (
            <div className="profile-settings-name-row">
              <strong title={resolvedName}>{resolvedName}</strong>
              <button
                className="profile-settings-name-edit"
                type="button"
                onClick={startNameEdit}
                disabled={saving}
                aria-label={t("Edit display name")}
                title={t("Edit display name")}
              >
                <Pencil size={13} />
              </button>
            </div>
          )}
          <span>@{visibleHandle}</span>
        </div>

      </section>

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
    <section className="profile-settings-section profile-usage-card" aria-label={t("Usage summary")}>
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
          <div className="profile-usage-details" aria-label={t("Usage insights")}>
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
          </div>
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
