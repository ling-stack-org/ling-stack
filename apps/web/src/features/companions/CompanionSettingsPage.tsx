import { useEffect, useMemo, useState } from "react";
import { Pause, Pencil, Play, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import type { AiTeammate, CompanionProfile } from "../../types.js";
import {
  createCompanion,
  disableCompanion,
  listAiTeammates,
  listCompanions,
  updateCompanion,
} from "../../api.js";
import { useI18n } from "../../i18n.js";
import { Button, Checkbox, Icon, IconButton, Input, Select, Textarea } from "../../shared/ui/index.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";

export function CompanionSettingsPage({
  cwd,
  onOpenMini,
}: {
  readonly cwd: string;
  readonly onOpenMini?: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [companions, setCompanions] = useState<readonly CompanionProfile[]>([]);
  const [teammates, setTeammates] = useState<readonly AiTeammate[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [teammateId, setTeammateId] = useState("");
  const [proactiveEnabled, setProactiveEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"create" | "save" | "disable" | "refresh" | undefined>();
  const [error, setError] = useState("");

  const activeTeammates = useMemo(
    () => teammates.filter((teammate) => teammate.status !== "disabled"),
    [teammates],
  );
  const selected = companions.find((companion) => companion.id === selectedId);
  const selectedTeammate = activeTeammates.find((teammate) => teammate.id === (selected?.teammateId ?? teammateId));

  useEffect(() => {
    if (!cwd.trim()) return;
    void refresh();
  }, [cwd]);

  useEffect(() => {
    if (!selected) return;
    setDisplayName(selected.displayName);
    setDescription(selected.description);
    setTeammateId(selected.teammateId);
    setProactiveEnabled(selected.behaviorPolicy.proactiveEnabled);
  }, [selected?.id]);

  async function refresh(): Promise<void> {
    if (!cwd.trim()) return;
    setBusy("refresh");
    setLoading(true);
    setError("");
    try {
      const [companionResponse, teammateResponse] = await Promise.all([
        listCompanions(cwd.trim()),
        listAiTeammates(cwd.trim()),
      ]);
      setCompanions(companionResponse.companions);
      setTeammates(teammateResponse.teammates);
      setSelectedId((current) => companionResponse.companions.some((item) => item.id === current)
        ? current
        : companionResponse.companions.find((item) => item.status !== "disabled")?.id ?? "");
      setTeammateId((current) => current || teammateResponse.teammates.find((item) => item.status !== "disabled")?.id || "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
      setBusy(undefined);
    }
  }

  function startCreate(): void {
    setSelectedId("");
    setDisplayName("");
    setDescription("");
    setProactiveEnabled(true);
    setTeammateId(activeTeammates[0]?.id ?? "");
    setError("");
  }

  async function save(): Promise<void> {
    const name = displayName.trim();
    if (!cwd.trim() || !name || !teammateId) return;
    setBusy(selected ? "save" : "create");
    setError("");
    try {
      const response = selected
        ? await updateCompanion(cwd.trim(), selected.id, {
          displayName: name,
          description: description.trim(),
          behaviorPolicy: { proactiveEnabled },
        })
        : await createCompanion(cwd.trim(), {
          teammateId,
          displayName: name,
          description: description.trim(),
          behaviorPolicy: { proactiveEnabled, cooldownMs: 300_000 },
        });
      setCompanions((current) => selected
        ? current.map((item) => item.id === response.companion.id ? response.companion : item)
        : [...current, response.companion]);
      setSelectedId(response.companion.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  }

  async function disable(): Promise<void> {
    if (!selected || !cwd.trim()) return;
    setBusy("disable");
    setError("");
    try {
      const response = await disableCompanion(cwd.trim(), selected.id);
      setCompanions((current) => current.map((item) => item.id === response.companion.id ? response.companion : item));
      setSelectedId("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="companion-settings-page">
      <header className="companion-settings-header">
        <div>
          <div className="companion-settings-title-row"><Icon icon={Sparkles} size="lg" /><h2>{t("Intelligent companion")}</h2></div>
          <p>{t("Manage companion appearance and behavior while keeping model selection in Ling's model settings.")}</p>
        </div>
        <div className="companion-settings-actions">
          <Button size="sm" variant="secondary" leadingIcon={<RefreshCw />} onClick={() => void refresh()} loading={busy === "refresh"}>{t("Refresh")}</Button>
          {onOpenMini ? <Button size="sm" variant="secondary" leadingIcon={<Sparkles />} onClick={onOpenMini}>{t("Show mini companion")}</Button> : null}
          <Button size="sm" variant="primary" leadingIcon={<Plus />} onClick={startCreate}>{t("Create companion")}</Button>
        </div>
      </header>

      {!cwd.trim() ? <div className="companion-settings-empty">{t("Choose a workspace to manage companions.")}</div> : null}
      {cwd.trim() && activeTeammates.length === 0 ? (
        <div className="companion-settings-empty">
          <strong>{t("No active AI teammate")}</strong>
          <span>{t("Create or enable an AI teammate first. The companion reuses its existing model binding.")}</span>
        </div>
      ) : null}

      {cwd.trim() && activeTeammates.length > 0 ? (
        <div className="companion-settings-grid">
          <section className="companion-settings-list" aria-label={t("My companions")}>
            <div className="companion-settings-list-heading"><span>{t("My companions")}</span><span>{companions.filter((item) => item.status !== "disabled").length}</span></div>
            {loading && companions.length === 0 ? <p className="companion-settings-muted">{t("Loading companions...")}</p> : null}
            {companions.filter((item) => item.status !== "disabled").map((companion) => {
              const owner = activeTeammates.find((item) => item.id === companion.teammateId);
              return (
                <button
                  key={companion.id}
                  type="button"
                  className={selectedId === companion.id ? "companion-settings-card selected" : "companion-settings-card"}
                  onClick={() => setSelectedId(companion.id)}
                >
                  {owner ? <TeammateAvatarView teammate={owner} cwd={cwd} compact /> : <span className="companion-settings-card-fallback" aria-hidden="true">🐾</span>}
                  <span className="companion-settings-card-copy"><strong>{companion.displayName}</strong><small>{owner?.displayName ?? t("Unknown teammate")}</small></span>
                  <span className={`companion-status-dot ${companion.status}`} aria-label={companion.status} />
                </button>
              );
            })}
            {companions.filter((item) => item.status !== "disabled").length === 0 ? <p className="companion-settings-muted">{t("No companion yet")}</p> : null}
          </section>

          <section className="companion-settings-editor" aria-label={selected ? t("Edit companion") : t("Create companion")}>
            <div className="companion-settings-editor-heading">
              <div><span className="companion-settings-eyebrow">{selected ? t("Edit companion") : t("New companion")}</span><h3>{selected?.displayName ?? t("Create your first companion")}</h3></div>
              {selected ? <IconButton label={t("Disable companion")} icon={Trash2} size="sm" onClick={() => void disable()} disabled={busy !== undefined} /> : null}
            </div>
            <label className="companion-settings-field"><span>{t("Companion name")}</span><Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={t("For example, Ling Star")} /></label>
            <label className="companion-settings-field"><span>{t("Description")}</span><Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder={t("A short description shown in the companion panel.")} /></label>
            <label className="companion-settings-field"><span>{t("Bound AI teammate")}</span><Select value={teammateId} onChange={(event) => setTeammateId(event.target.value)} disabled={Boolean(selected)}>
              <option value="">{t("Select a teammate")}</option>
              {activeTeammates.map((teammate) => <option key={teammate.id} value={teammate.id}>{teammate.displayName}</option>)}
            </Select></label>
            {selectedTeammate ? <p className="companion-settings-binding">{t("Model selection follows {name}'s existing Ling configuration.", { name: selectedTeammate.displayName })}</p> : null}
            <Checkbox
              className="companion-settings-toggle"
              checked={proactiveEnabled}
              onChange={(event) => setProactiveEnabled(event.target.checked)}
              label={<span>{proactiveEnabled ? <Play size={14} /> : <Pause size={14} />}{t("Allow proactive companion prompts")}</span>}
            />
            <div className="companion-settings-editor-actions"><Button variant="primary" onClick={() => void save()} disabled={!displayName.trim() || !teammateId || busy !== undefined} loading={busy === "save" || busy === "create"}>{selected ? t("Save companion") : t("Create companion")}</Button>{selected ? <Button variant="ghost" onClick={startCreate} disabled={busy !== undefined}>{t("New companion")}</Button> : null}</div>
          </section>
        </div>
      ) : null}

      {error ? <p className="companion-settings-error" role="alert">{error}</p> : null}
    </div>
  );
}
