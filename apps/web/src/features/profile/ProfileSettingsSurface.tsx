import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject } from "react";
import { Camera, Pencil, Sparkles } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  DataRow,
  EmptyState,
  IconButton,
  InlineFeedback,
  Input,
  SegmentedControl,
  SegmentedControlItem,
  Skeleton,
} from "../../shared/ui/index.js";

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
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly errorMessage: string;
  readonly onRetryLoad: () => void;
  readonly avatarButtonRef: RefObject<HTMLButtonElement | null>;
  readonly fileInputRef: RefObject<HTMLInputElement | null>;
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
  loaded,
  loading,
  saving,
  errorMessage,
  onRetryLoad,
  avatarButtonRef,
  fileInputRef,
  onAvatarChange,
  onCommitDisplayName,
  onActivityModeChange,
  formatCompactNumber,
  formatDuration,
}: ProfileSettingsSurfaceProps): React.JSX.Element {
  const { t } = useI18n();
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const nameEditButtonRef = useRef<HTMLButtonElement | null>(null);
  const skipBlurCommitRef = useRef(false);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(displayName);
  const resolvedName = displayName.trim() || "Ling User";

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

  function startNameEdit(): void {
    setDraftName(resolvedName);
    setEditingName(true);
  }

  function cancelNameEdit(): void {
    skipBlurCommitRef.current = true;
    setDraftName(displayName);
    setEditingName(false);
    window.requestAnimationFrame(() => nameEditButtonRef.current?.focus());
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

  const hasActivity = hasProfileActivity(metrics);
  const profileState = loading && !loaded ? "loading" : errorMessage ? "error" : hasActivity ? "loaded" : "empty";

  if (!loaded && loading) {
    return <ProfileSettingsLoading title={t("User profile")} />;
  }

  return (
    <div
      className="profile-settings-surface"
      aria-label={t("User profile")}
      data-profile-state={profileState}
      data-ui2-settings-profile="true"
    >
      {!loaded && errorMessage ? (
        <InlineFeedback className="profile-settings-feedback" tone="danger" title={t("Profile needs attention")}>
          <span>{errorMessage}</span>
          <Button size="sm" variant="secondary" onClick={onRetryLoad}>{t("Retry")}</Button>
        </InlineFeedback>
      ) : null}

      {loaded ? (
        <>
      <section className="profile-settings-section profile-settings-identity-block" aria-label={t("User profile")} data-profile-section="identity">
        <IconButton
          ref={avatarButtonRef}
          className={avatarDataUrl ? "profile-settings-avatar has-avatar" : "profile-settings-avatar"}
          disabled={saving}
          icon={(
            <span className="profile-settings-avatar-visual">
              {avatarDataUrl ? <img src={avatarDataUrl} alt="" /> : <span>{initials}</span>}
              <span className="profile-settings-avatar-edit"><Camera size={15} /></span>
            </span>
          )}
          label={t("Change avatar")}
          size="lg"
          tooltip={t("Change avatar")}
          onClick={() => fileInputRef.current?.click()}
        />
        <input ref={fileInputRef} data-ling-control-native="true" type="file" accept="image/*" hidden onChange={onAvatarChange} />

        <div className="profile-settings-name-stack">
          {editingName ? (
            <Input
              ref={nameInputRef}
              className="profile-settings-name-input-native"
              containerClassName="profile-settings-name-input"
              aria-label={t("Display name")}
              value={draftName}
              maxLength={80}
              disabled={saving}
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={handleNameBlur}
              onKeyDown={handleNameKeyDown}
            />
          ) : (
            <div className="profile-settings-name-row" data-profile-name-row="true">
              <strong title={resolvedName}>{resolvedName}</strong>
              <IconButton
                ref={nameEditButtonRef}
                className="profile-settings-name-edit"
                disabled={saving}
                icon={Pencil}
                label={t("Edit display name")}
                loading={saving}
                loadingLabel={t("Saving profile")}
                size="sm"
                tooltip={t("Edit display name")}
                onClick={startNameEdit}
              />
            </div>
          )}
          <span>@{visibleHandle}</span>
        </div>

      </section>

      {errorMessage ? (
        <InlineFeedback className="profile-settings-feedback" tone="danger" title={t("Profile needs attention")}>
          {errorMessage}
        </InlineFeedback>
      ) : null}

      <ProfileUsageSummary
        metrics={metrics}
        activity={activity}
        activityMode={activityMode}
        onActivityModeChange={onActivityModeChange}
        formatCompactNumber={formatCompactNumber}
        formatDuration={formatDuration}
      />
        </>
      ) : null}
    </div>
  );
}

function ProfileSettingsLoading({ title }: { readonly title: string }): React.JSX.Element {
  return (
    <div
      className="profile-settings-surface profile-settings-loading"
      aria-busy="true"
      aria-label={title}
      data-profile-state="loading"
      data-ui2-settings-profile="true"
    >
      <section className="profile-settings-section profile-settings-identity-block" aria-label={title} data-profile-section="identity">
        <Skeleton className="profile-settings-avatar-skeleton" shape="circle" width={84} height={84} />
        <Skeleton width={180} height={28} />
      </section>
      <section className="profile-settings-section profile-usage-card" aria-label={title} data-profile-section="usage">
        <div className="profile-usage-summary-grid" data-profile-usage-summary="true">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} shape="block" height={62} />
          ))}
        </div>
      </section>
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
}): React.JSX.Element {
  const { t } = useI18n();
  const hasActivity = hasProfileActivity(metrics);

  return (
    <section className="profile-settings-section profile-usage-card" aria-label={t("Usage summary")} data-profile-section="usage">
      {hasActivity ? (
        <>
          <div className="profile-usage-summary-grid" aria-label={t("Profile usage summary")} data-profile-usage-summary="true">
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
          <div className="profile-usage-details" data-profile-usage="true" aria-label={t("Usage insights")}>
            <div className="profile-usage-details-body">
              <div className="profile-settings-activity-head">
                <h3>{t("Token activity")}</h3>
                <SegmentedControl
                  className="profile-settings-activity-range"
                  aria-label={t("Token activity range")}
                  size="sm"
                  value={activityMode}
                  onValueChange={(value) => onActivityModeChange(value as ActivityMode)}
                >
                  {([
                    ["day", t("Daily")],
                    ["week", t("Weekly")],
                    ["total", t("Cumulative")],
                  ] as const).map(([mode, label]) => (
                    <SegmentedControlItem key={mode} value={mode}>{label}</SegmentedControlItem>
                  ))}
                </SegmentedControl>
              </div>
              <div className="profile-settings-activity-body">
                <div className="profile-settings-heatmap" role="img" aria-label={t("Token activity heatmap for the past year")}>
                  <div className="profile-settings-heatmap-grid">
                    {activity.cells.map((cell) => (
                      <span key={cell.date} className={`profile-settings-heatmap-cell level-${cell.level}`} title={t("{date}: {value} estimated tokens", { date: cell.date, value: formatCompactNumber(cell.value) })} />
                    ))}
                  </div>
                  <div className="profile-settings-heatmap-months" aria-hidden="true">
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
                  <div className="profile-settings-skill-list">
                    {metrics.topSkills.map((skill) => (
                      <DataRow
                        key={skill.id}
                        compact
                        className="profile-settings-skill-row"
                        data-profile-skill-row="true"
                        identity={(
                          <span className="profile-settings-skill-identity">
                            <Sparkles size={14} aria-hidden="true" />
                            <strong title={skill.label}>{skill.label}</strong>
                          </span>
                        )}
                        status={<span>{t(skill.count === 1 ? "{count} run" : "{count} runs", { count: skill.count })}</span>}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyState compact title={t("No skill-backed runs yet.")} />
                )}
              </div>
            </div>
          </div>
        </>
      ) : (
        <EmptyState compact className="profile-usage-empty" title={t("Not enough local activity yet.")} />
      )}
    </section>
  );
}

function ProfileUsageMetric({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <span className="profile-usage-metric">
      <small>{label}</small>
      <strong title={value}>{value}</strong>
    </span>
  );
}

function hasProfileActivity(metrics: ProfileMetrics): boolean {
  return metrics.sessionCount > 0 || metrics.totalEstimatedTokens > 0 || metrics.topSkills.length > 0;
}
