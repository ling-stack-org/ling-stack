import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Bot, Camera, Check, Pencil, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { getUserProfile, updateUserProfile } from "../../api/profile.js";
import { listRuns } from "../../api/runs.js";
import { listSkills } from "../../api/skills.js";
import { useI18n, type Locale } from "../../i18n.js";
import { useFocusRevalidationToken } from "../../shared/hooks/use-focus-revalidation-token.js";
import { Button, Field, Input, useLingToast } from "../../shared/ui/index.js";
import type { RunSession, SkillRegistryEntry, UserProfile } from "../../types.js";
import { AvatarCropDialog } from "./AvatarCropDialog.js";
import { ProfileSettingsSurface, type ActivityMode, type ProfileMetrics } from "./ProfileSettingsSurface.js";

export function ProfilePage({
  cwd,
  onProfileChange,
  variant = "standalone",
}: {
  readonly cwd: string;
  readonly onProfileChange?: (profile: UserProfile) => void;
  readonly variant?: "standalone" | "settings";
}): JSX.Element {
  const { locale, t } = useI18n();
  const focusRevalidationToken = useFocusRevalidationToken();
  const { showToast } = useLingToast();
  const avatarTriggerRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [profile, setProfile] = useState<UserProfile | undefined>();
  const [runs, setRuns] = useState<readonly RunSession[]>([]);
  const [skills, setSkills] = useState<readonly SkillRegistryEntry[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | undefined>();
  const [avatarCropSource, setAvatarCropSource] = useState<string | undefined>();
  const [activityMode, setActivityMode] = useState<ActivityMode>("day");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const metrics = useMemo(() => buildProfileMetrics(runs, skills, t("Not recorded")), [runs, skills, t]);
  const activity = useMemo(
    () => buildActivityCalendar(metrics.activityDays, activityMode, locale),
    [activityMode, locale, metrics.activityDays],
  );
  const hasProfileChanges =
    profile !== undefined &&
    (displayName.trim() !== profile.displayName || avatarDataUrl !== profile.avatarDataUrl);

  useEffect(() => {
    void refresh();
  }, [cwd, focusRevalidationToken]);

  async function refresh(): Promise<void> {
    if (!cwd.trim()) {
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const [profileResponse, runsResponse, skillsResponse] = await Promise.all([
        getUserProfile(cwd),
        listRuns(cwd, { limit: 200 }),
        listSkills(cwd),
      ]);
      setProfile(profileResponse.profile);
      onProfileChange?.(profileResponse.profile);
      setDisplayName(profileResponse.profile.displayName);
      setAvatarDataUrl(profileResponse.profile.avatarDataUrl);
      setRuns(runsResponse.runs);
      setSkills(skillsResponse.skills);
    } catch {
      setMessage(t("Profile could not be loaded. Try reopening this page."));
    } finally {
      setLoading(false);
    }
  }

  async function saveProfilePatch({
    displayName: nextDisplayName = displayName,
    avatarDataUrl: nextAvatarDataUrl = avatarDataUrl ?? null,
  }: {
    readonly displayName?: string;
    readonly avatarDataUrl?: string | null;
  }): Promise<UserProfile | undefined> {
    if (!cwd.trim() || saving) {
      return undefined;
    }
    setSaving(true);
    setMessage("");
    try {
      const response = await updateUserProfile(cwd, {
        displayName: nextDisplayName,
        handle: profile?.handle ?? null,
        avatarDataUrl: nextAvatarDataUrl,
      });
      setProfile(response.profile);
      onProfileChange?.(response.profile);
      setDisplayName(response.profile.displayName);
      setAvatarDataUrl(response.profile.avatarDataUrl);
      setMessage("");
      showToast({ message: t("Profile saved"), scope: "profile:save", tone: "success" });
      return response.profile;
    } catch {
      setMessage(t("Profile changes were not saved. Try again."));
      return undefined;
    } finally {
      setSaving(false);
    }
  }

  async function saveProfile(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    await saveProfilePatch({
      displayName,
      avatarDataUrl: avatarDataUrl ?? null,
    });
  }

  async function commitSettingsDisplayName(value: string): Promise<void> {
    const nextDisplayName = value.trim();
    const previousDisplayName = profile?.displayName ?? displayName;
    if (!nextDisplayName || nextDisplayName === previousDisplayName) {
      setDisplayName(previousDisplayName);
      return;
    }
    setDisplayName(nextDisplayName);
    const savedProfile = await saveProfilePatch({
      displayName: nextDisplayName,
      avatarDataUrl: avatarDataUrl ?? null,
    });
    if (!savedProfile) {
      setDisplayName(previousDisplayName);
    }
  }

  async function commitSettingsAvatar(avatarDataUrlPatch: string): Promise<void> {
    const previousAvatarDataUrl = avatarDataUrl;
    setAvatarCropSource(undefined);
    setAvatarDataUrl(avatarDataUrlPatch);
    const savedProfile = await saveProfilePatch({
      displayName: displayName || profile?.displayName || "Ling User",
      avatarDataUrl: avatarDataUrlPatch,
    });
    if (!savedProfile) {
      setAvatarDataUrl(previousAvatarDataUrl);
    }
    window.requestAnimationFrame(() => avatarTriggerRef.current?.focus());
  }

  function closeSettingsAvatarCrop(): void {
    setAvatarCropSource(undefined);
    window.requestAnimationFrame(() => avatarTriggerRef.current?.focus());
  }

  async function handleAvatarChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    if (!file.type.startsWith("image/")) {
      setMessage(t("Choose an image file"));
      event.target.value = "";
      return;
    }
    try {
      setAvatarCropSource(await fileToDataUrl(file));
      setMessage("");
    } catch {
      setMessage(t("The image could not be opened. Choose another file."));
    } finally {
      event.target.value = "";
    }
  }

  const initials = initialsFromName(displayName || profile?.displayName || "Ling User");
  const visibleHandle = profile?.handle || "local-user";

  if (variant === "settings") {
    return (
      <>
        <ProfileSettingsSurface
          displayName={displayName}
          visibleHandle={visibleHandle}
          avatarDataUrl={avatarDataUrl}
          initials={initials}
          metrics={metrics}
          activity={activity}
          activityMode={activityMode}
          loaded={profile !== undefined}
          loading={loading}
          saving={saving}
          errorMessage={message}
          onRetryLoad={() => void refresh()}
          avatarButtonRef={avatarTriggerRef}
          fileInputRef={fileInputRef}
          onAvatarChange={(event) => void handleAvatarChange(event)}
          onCommitDisplayName={commitSettingsDisplayName}
          onActivityModeChange={setActivityMode}
          formatCompactNumber={(value) => formatCompactNumber(value, locale)}
          formatDuration={(value) => formatDuration(value, locale)}
        />
        {avatarCropSource ? (
          <AvatarCropDialog
            sourceDataUrl={avatarCropSource}
            onCancel={closeSettingsAvatarCrop}
            onConfirm={(croppedAvatarDataUrl) => void commitSettingsAvatar(croppedAvatarDataUrl)}
          />
        ) : null}
      </>
    );
  }

  return (
    <div className="profile-page">
      <header className="profile-topbar" data-desktop-window-drag-region="true">
        <div>
          <p className="profile-kicker">个人资料</p>
          <h1>{profile?.displayName ?? (displayName || "Ling User")}</h1>
        </div>
        <div className="profile-actions">
          <button className="primary-button compact-button" type="button" onClick={() => void saveProfile()} disabled={!hasProfileChanges || saving}>
            {saving ? <RefreshCw size={14} /> : <Check size={14} />}
            <span>{saving ? "保存中" : "保存资料"}</span>
          </button>
        </div>
      </header>

      <section className="profile-hero" aria-label="个人资料概览">
        <button
          className={avatarDataUrl ? "profile-avatar-button has-avatar" : "profile-avatar-button"}
          type="button"
          onClick={() => fileInputRef.current?.click()}
          aria-label="更换头像"
          title="更换头像"
        >
          {avatarDataUrl ? <img src={avatarDataUrl} alt="" /> : <span>{initials}</span>}
          <span className="profile-avatar-edit"><Camera size={15} /></span>
        </button>
        <input ref={fileInputRef} data-ling-control-native="true" type="file" accept="image/*" hidden onChange={(event) => void handleAvatarChange(event)} />
        <form className="profile-identity-form" onSubmit={(event) => void saveProfile(event)}>
          <Field className="profile-identity-field" controlId="standalone-profile-display-name" label="昵称">
            <Input
              value={displayName}
              maxLength={80}
              autoComplete="name"
              disabled={saving}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>
          <div className="profile-identity-readonly" data-profile-handle-readonly="true">
            <span>用户名</span>
            <strong>@{visibleHandle}</strong>
          </div>
          <p>本地个人资料</p>
        </form>
      </section>

      <section className="profile-stat-strip" aria-label="Token 和连续使用统计">
        <ProfileStat value={formatCompactNumber(metrics.totalEstimatedTokens, locale)} label="累计估算 Token" />
        <ProfileStat value={formatCompactNumber(metrics.peakEstimatedTokens, locale)} label="峰值估算 Token" />
        <ProfileStat value={formatDuration(metrics.longestDurationMs, locale)} label="最长任务时长" />
        <ProfileStat value={`${metrics.currentStreakDays} 天`} label="当前连续天数" />
        <ProfileStat value={`${metrics.longestStreakDays} 天`} label="最长连续天数" />
      </section>

      <section className="profile-activity-section" aria-label="Token 活动">
        <div className="profile-section-head">
          <h2>Token 活动</h2>
          <div className="profile-segmented" role="tablist" aria-label="Token 活动粒度">
            {([
              ["day", "每日"],
              ["week", "每周"],
              ["total", "累计"],
            ] as const).map(([mode, label]) => (
              <button key={mode} type="button" className={activityMode === mode ? "active" : ""} onClick={() => setActivityMode(mode)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="profile-activity-body">
          <div className="profile-heatmap" role="img" aria-label="过去一年 Token 活动热力图">
            <div className="profile-heatmap-grid">
              {activity.cells.map((cell) => (
                <span key={cell.date} className={`profile-heatmap-cell level-${cell.level}`} title={`${cell.date}: ${formatCompactNumber(cell.value, locale)} 估算 Token`} />
              ))}
            </div>
            <div className="profile-heatmap-months" aria-hidden="true">
              {activity.monthLabels.map((label) => <span key={`${label.month}-${label.column}`} style={{ gridColumn: label.column }}>{label.month}</span>)}
            </div>
          </div>
        </div>
      </section>

      <div className="profile-detail-grid">
        <section className="profile-insights" aria-label="活动洞察">
          <h2>活动洞察</h2>
          <ProfileInsight icon={<ShieldCheck size={16} />} label="任务成功率" value={`${metrics.successRate}%`} />
          <ProfileInsight icon={<Bot size={16} />} label="最常用的模型" value={metrics.topModel} />
          <ProfileInsight icon={<Sparkles size={16} />} label="已探索的技能" value={String(metrics.exploredSkillCount)} />
          <ProfileInsight icon={<Pencil size={16} />} label="使用的技能总数" value={String(metrics.totalSkillCount)} />
          <ProfileInsight icon={<Check size={16} />} label="会话总数" value={String(metrics.sessionCount)} />
        </section>

        <section className="profile-top-skills" aria-label="最常用的技能">
          <h2>最常用的技能</h2>
          {metrics.topSkills.length > 0 ? (
            <div className="profile-skill-list">
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
        </section>
      </div>

      {message ? (
        <div className={message.includes("已") ? "profile-message ok" : "profile-message"}>
          <span>{message}</span>
          {!profile ? <Button size="sm" variant="secondary" onClick={() => void refresh()}>{t("Retry")}</Button> : null}
        </div>
      ) : null}
      {avatarCropSource ? (
        <AvatarCropDialog
          sourceDataUrl={avatarCropSource}
          onCancel={() => setAvatarCropSource(undefined)}
          onConfirm={(croppedAvatarDataUrl) => {
            setAvatarDataUrl(croppedAvatarDataUrl);
            setAvatarCropSource(undefined);
            setMessage("头像已调整，保存后生效");
          }}
        />
      ) : null}
    </div>
  );
}

function ProfileStat({ value, label }: { readonly value: string; readonly label: string }): JSX.Element {
  return <div className="profile-stat"><strong>{value}</strong><span>{label}</span></div>;
}

function ProfileInsight({ icon, label, value }: { readonly icon: JSX.Element; readonly label: string; readonly value: string }): JSX.Element {
  return <div className="profile-insight-row"><span className="profile-insight-icon">{icon}</span><span>{label}</span><strong>{value}</strong></div>;
}

function buildProfileMetrics(
  runs: readonly RunSession[],
  skills: readonly SkillRegistryEntry[],
  notRecordedLabel: string,
): ProfileMetrics {
  const skillLabels = new Map(skills.map((entry) => [entry.id, entry.definition.name || entry.id]));
  const skillCounts = new Map<string, number>();
  const modelCounts = new Map<string, number>();
  const activityDays = new Map<string, number>();
  let totalEstimatedTokens = 0;
  let peakEstimatedTokens = 0;
  let longestDurationMs = 0;
  let succeeded = 0;

  for (const run of runs) {
    const estimatedTokens = estimateRunTokens(run);
    totalEstimatedTokens += estimatedTokens;
    peakEstimatedTokens = Math.max(peakEstimatedTokens, estimatedTokens);
    activityDays.set(localDateKey(new Date(run.createdAt)), (activityDays.get(localDateKey(new Date(run.createdAt))) ?? 0) + estimatedTokens);
    if (run.selectedSkillId) {
      skillCounts.set(run.selectedSkillId, (skillCounts.get(run.selectedSkillId) ?? 0) + 1);
    }
    if (run.status === "succeeded") {
      succeeded += 1;
    }
    longestDurationMs = Math.max(longestDurationMs, runDurationMs(run));
    const model = readRunModel(run);
    if (model) {
      modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
    }
  }

  const activeDays = new Set(activityDays.keys());
  const topSkills = [...skillCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([id, count]) => ({ id, label: skillLabels.get(id) ?? id, count }));
  const topModel = [...modelCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? notRecordedLabel;

  return {
    totalEstimatedTokens,
    peakEstimatedTokens,
    longestDurationMs,
    currentStreakDays: currentStreak(activeDays),
    longestStreakDays: longestStreak(activeDays),
    sessionCount: runs.length,
    successRate: runs.length === 0 ? 0 : Math.round((succeeded / runs.length) * 100),
    topModel,
    exploredSkillCount: skillCounts.size,
    totalSkillCount: skills.length,
    topSkills,
    activityDays,
  };
}

function buildActivityCalendar(activityDays: ReadonlyMap<string, number>, mode: ActivityMode, locale: Locale): {
  readonly cells: readonly { readonly date: string; readonly value: number; readonly level: number }[];
  readonly monthLabels: readonly { readonly month: string; readonly column: number }[];
} {
  const today = startOfLocalDay(new Date());
  const start = addDays(today, -364);
  const alignedStart = addDays(start, -start.getDay());
  const dates = Array.from({ length: 53 * 7 }, (_, index) => addDays(alignedStart, index));
  const values = dates.map((date) => {
    const key = localDateKey(date);
    if (mode === "day") {
      return activityDays.get(key) ?? 0;
    }
    if (mode === "week") {
      return sumWeek(activityDays, date);
    }
    return sumUntil(activityDays, key);
  });
  const max = Math.max(...values, 1);
  const cells = dates.map((date, index) => {
    const value = values[index] ?? 0;
    return { date: localDateKey(date), value, level: value === 0 ? 0 : Math.max(1, Math.min(4, Math.ceil((value / max) * 4))) };
  });
  const monthLabels: { month: string; column: number }[] = [];
  let previousMonth = -1;
  dates.forEach((date, index) => {
    const month = date.getMonth();
    if (month !== previousMonth && index % 7 === 0) {
      monthLabels.push({
        month: new Intl.DateTimeFormat(locale, { month: "short" }).format(date),
        column: Math.floor(index / 7) + 1,
      });
      previousMonth = month;
    }
  });
  return { cells, monthLabels };
}

function estimateRunTokens(run: RunSession): number {
  const text = collectStrings([run.taskSnapshot, run.requestSnapshot]).join("\n");
  const fallback = text || JSON.stringify([run.taskSnapshot, run.requestSnapshot]);
  return Math.max(1, Math.ceil(fallback.length / 4));
}

function collectStrings(values: readonly unknown[]): string[] {
  const result: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.trim()) {
        result.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, nested] of Object.entries(value)) {
        if (/^(prompt|title|objective|instruction|message|text|summary|systemPrompt|appendSystemPrompt)$/i.test(key)) {
          visit(nested);
        }
      }
    }
  };
  values.forEach(visit);
  return result;
}

function readRunModel(run: RunSession): string {
  if (run.providerModel.trim()) {
    return run.providerModel.trim();
  }
  const snapshotModel = readModelFromRecord(run.requestSnapshot) || readModelFromRecord(run.providerSnapshot);
  return snapshotModel || run.providerName.trim();
}

function readModelFromRecord(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const record = value as Record<string, unknown>;
  for (const key of ["model", "modelId", "providerModel"]) {
    const entry = record[key];
    if (typeof entry === "string" && entry.trim()) {
      return entry.trim();
    }
  }
  const request = record.request;
  return readModelFromRecord(request);
}

function runDurationMs(run: RunSession): number {
  const start = Date.parse(run.startedAt ?? run.createdAt);
  const end = Date.parse(run.endedAt ?? run.updatedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : 0;
}

function currentStreak(activeDays: ReadonlySet<string>): number {
  let count = 0;
  let cursor = startOfLocalDay(new Date());
  while (activeDays.has(localDateKey(cursor))) {
    count += 1;
    cursor = addDays(cursor, -1);
  }
  return count;
}

function longestStreak(activeDays: ReadonlySet<string>): number {
  let longest = 0;
  let current = 0;
  let previous: Date | undefined;
  for (const key of [...activeDays].sort()) {
    const date = new Date(`${key}T00:00:00`);
    current = previous && differenceInDays(date, previous) === 1 ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = date;
  }
  return longest;
}

function sumWeek(activityDays: ReadonlyMap<string, number>, date: Date): number {
  const start = addDays(date, -date.getDay());
  return Array.from({ length: 7 }, (_, index) => activityDays.get(localDateKey(addDays(start, index))) ?? 0).reduce((sum, value) => sum + value, 0);
}

function sumUntil(activityDays: ReadonlyMap<string, number>, key: string): number {
  let sum = 0;
  for (const [day, value] of activityDays.entries()) {
    if (day <= key) {
      sum += value;
    }
  }
  return sum;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function differenceInDays(left: Date, right: Date): number {
  return Math.round((startOfLocalDay(left).getTime() - startOfLocalDay(right).getTime()) / 86_400_000);
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatCompactNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    notation: value >= 10_000 ? "compact" : "standard",
  }).format(value);
}

function formatDuration(value: number, locale: Locale): string {
  if (value <= 0) {
    return locale === "zh-CN" ? "0 分" : "0 min";
  }
  const minutes = Math.round(value / 60_000);
  if (minutes < 60) {
    return locale === "zh-CN" ? `${minutes} 分` : `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (locale === "zh-CN") {
    return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
  }
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

function initialsFromName(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const initials = parts.length >= 2 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : value.trim().slice(0, 2);
  return initials.toUpperCase() || "LU";
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Failed to read avatar")));
    reader.readAsDataURL(file);
  });
}
