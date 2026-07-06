import { type ChangeEvent, type FormEvent, type RefObject } from "react";
import { Bot, Camera, Check, MessageSquare, RefreshCw, RotateCcw, ShieldCheck, Sparkles, UserRound } from "lucide-react";

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
  const resolvedName = displayName.trim() || "Ling User";

  return (
    <div className="profile-settings-surface" aria-label="个人资料">
      <header className="profile-settings-head">
        <div>
          <h1>个人资料</h1>
          <p>设置你在频道、私聊和审批记录中的显示身份。</p>
        </div>
        <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={14} />
          <span>{loading ? "刷新中" : "刷新"}</span>
        </button>
      </header>

      <div className="profile-settings-primary-grid">
        <section className="profile-settings-card profile-identity-card" aria-label="身份信息">
          <div className="profile-settings-card-head">
            <span className="profile-settings-card-icon"><UserRound size={16} /></span>
            <div>
              <h2>身份信息</h2>
              <p>这些信息仅用于当前本地工作区显示。</p>
            </div>
          </div>

          <form className="profile-settings-form" onSubmit={onSave}>
            <div className="profile-settings-avatar-row">
              <button
                className={avatarDataUrl ? "profile-avatar-button profile-settings-avatar has-avatar" : "profile-avatar-button profile-settings-avatar"}
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="更换头像"
                title="更换头像"
              >
                {avatarDataUrl ? <img src={avatarDataUrl} alt="" /> : <span>{initials}</span>}
                <span className="profile-avatar-edit"><Camera size={14} /></span>
              </button>
              <div>
                <strong>{resolvedName}</strong>
                <span>@{visibleHandle}</span>
                <button className="secondary-button compact-button" type="button" onClick={() => fileInputRef.current?.click()}>
                  更换头像
                </button>
              </div>
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onAvatarChange} />

            <div className="profile-settings-fields">
              <label>
                <span>昵称</span>
                <input value={displayName} onChange={(event) => onDisplayNameChange(event.target.value)} maxLength={80} />
              </label>
              <label>
                <span>用户名</span>
                <input value={handle} onChange={(event) => onHandleChange(event.target.value)} maxLength={48} placeholder="local-user" />
              </label>
            </div>

            <footer className="profile-settings-actions">
              {message ? <span className={message.includes("已") ? "profile-inline-message ok" : "profile-inline-message"}>{message}</span> : <span />}
              <div>
                {hasProfileChanges ? (
                  <button className="secondary-button compact-button" type="button" onClick={onReset} disabled={saving}>
                    <RotateCcw size={14} />
                    <span>重置更改</span>
                  </button>
                ) : null}
                <button className="primary-button compact-button" type="submit" disabled={!hasProfileChanges || saving}>
                  {saving ? <RefreshCw size={14} /> : <Check size={14} />}
                  <span>{saving ? "保存中" : "保存资料"}</span>
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
  return (
    <section className="profile-settings-card profile-preview-card" aria-label="显示预览">
      <div className="profile-settings-card-head">
        <span className="profile-settings-card-icon"><MessageSquare size={16} /></span>
        <div>
          <h2>显示预览</h2>
          <p>这些位置会使用你的头像和昵称。</p>
        </div>
      </div>
      <div className="profile-preview-message" aria-label="个人资料显示预览">
        <ProfilePreviewAvatar avatarDataUrl={avatarDataUrl} initials={initials} />
        <div>
          <header>
            <strong>{displayName}</strong>
            <span>@{visibleHandle}</span>
          </header>
          <p>我会以这个身份出现在本地消息、私聊和审批记录中。</p>
        </div>
      </div>
      <div className="profile-preview-usage-list">
        <ProfilePreviewUsage icon={<MessageSquare size={14} />} label="频道消息" />
        <ProfilePreviewUsage icon={<Bot size={14} />} label="AI 队友私聊" />
        <ProfilePreviewUsage icon={<ShieldCheck size={14} />} label="审批记录" />
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
  const hasActivity = metrics.sessionCount > 0 || metrics.totalEstimatedTokens > 0 || metrics.topSkills.length > 0;

  return (
    <section className="profile-settings-card profile-usage-card" aria-label="使用摘要">
      <div className="profile-settings-card-head split">
        <span className="profile-settings-card-icon"><Sparkles size={16} /></span>
        <div>
          <h2>使用摘要</h2>
          <p>这里保留本地活动概览、趋势和连续使用记录。</p>
        </div>
      </div>

      {hasActivity ? (
        <>
          <div className="profile-usage-summary-grid" aria-label="个人资料使用摘要">
            <ProfileUsageMetric label="会话数" value={String(metrics.sessionCount)} />
            <ProfileUsageMetric label="任务成功率" value={`${metrics.successRate}%`} />
            <ProfileUsageMetric label="常用模型" value={metrics.topModel} />
            <ProfileUsageMetric label="已使用技能" value={String(metrics.exploredSkillCount)} />
          </div>
          <div className="profile-usage-meta-line">
            <span>累计估算 Token <strong>{formatCompactNumber(metrics.totalEstimatedTokens)}</strong></span>
            <span>最长任务 <strong>{formatDuration(metrics.longestDurationMs)}</strong></span>
            <span>最长连续 <strong>{metrics.longestStreakDays} 天</strong></span>
          </div>
          <details className="profile-usage-details" open>
            <summary>使用洞察</summary>
            <div className="profile-usage-details-body">
              <div className="profile-section-head">
                <h3>Token 活动</h3>
                <div className="profile-segmented" role="tablist" aria-label="Token 活动粒度">
                  {([
                    ["day", "每日"],
                    ["week", "每周"],
                    ["total", "累计"],
                  ] as const).map(([mode, label]) => (
                    <button key={mode} type="button" className={activityMode === mode ? "active" : ""} onClick={() => onActivityModeChange(mode)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="profile-activity-body">
                <div className="profile-heatmap" role="img" aria-label="过去一年 Token 活动热力图">
                  <div className="profile-heatmap-grid">
                    {activity.cells.map((cell) => (
                      <span key={cell.date} className={`profile-heatmap-cell level-${cell.level}`} title={`${cell.date}: ${formatCompactNumber(cell.value)} 估算 Token`} />
                    ))}
                  </div>
                  <div className="profile-heatmap-months" aria-hidden="true">
                    {activity.monthLabels.map((label) => <span key={`${label.month}-${label.column}`} style={{ gridColumn: label.column }}>{label.month}</span>)}
                  </div>
                </div>
              </div>
              <div className="profile-usage-streak-section">
                <h3>连续使用</h3>
                <div className="profile-usage-streak-grid">
                  <ProfileUsageMetric label="当前连续" value={`${metrics.currentStreakDays} 天`} />
                  <ProfileUsageMetric label="最长连续" value={`${metrics.longestStreakDays} 天`} />
                  <ProfileUsageMetric label="峰值 Token" value={formatCompactNumber(metrics.peakEstimatedTokens)} />
                </div>
              </div>
              <div className="profile-usage-skill-section">
                <h3>最常用的技能</h3>
                {metrics.topSkills.length > 0 ? (
                  <div className="profile-skill-list compact">
                    {metrics.topSkills.map((skill) => (
                      <div key={skill.id} className="profile-skill-row">
                        <span className="profile-skill-icon"><Sparkles size={14} /></span>
                        <strong>{skill.label}</strong>
                        <span>{skill.count} 次运行</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="profile-empty">还没有带技能的运行记录。</p>
                )}
              </div>
            </div>
          </details>
        </>
      ) : (
        <p className="profile-usage-empty">还没有足够的本地活动记录。</p>
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
