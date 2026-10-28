import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { getSkillDefinitionHistory, undoSkillDefinitionRevision } from "../../../api.js";
import { useI18n } from "../../../i18n.js";
import type { SkillDefinitionRevision, SkillRegistryEntry } from "../../../types.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, InlineFeedback } from "../../ui/index.js";
import { SkillDefinitionDiff } from "./SkillDefinitionDiff.js";

export function SkillDefinitionHistory(props: { readonly cwd: string; readonly skill: SkillRegistryEntry;
  readonly editable: boolean; readonly onChanged?: () => Promise<void> }): React.JSX.Element {
  return <SkillDefinitionHistoryContent key={`${props.cwd}:${props.skill.id}`} {...props} />;
}
function SkillDefinitionHistoryContent({ cwd, skill, editable, onChanged }: {
  readonly cwd: string; readonly skill: SkillRegistryEntry; readonly editable: boolean; readonly onChanged?: () => Promise<void>;
}): React.JSX.Element {
  const { t } = useI18n();
  const [opened, setOpened] = useState(false);
  const [revisions, setRevisions] = useState<readonly SkillDefinitionRevision[]>([]);
  const [target, setTarget] = useState<{ readonly revision: SkillDefinitionRevision; readonly updatedAt: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restored, setRestored] = useState(false);
  const alive = useRef(false);
  const generation = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current += 1; }; }, []);
  useEffect(() => { if (opened) void refresh(); }, [opened, skill.updatedAt]);
  async function refresh(): Promise<void> {
    const revision = ++generation.current;
    try {
      const response = await getSkillDefinitionHistory(cwd, skill.id);
      if (alive.current && revision === generation.current) { setRevisions(response.revisions); setError(""); }
    } catch (caught) { if (alive.current && revision === generation.current) setError(caught instanceof Error ? caught.message : String(caught)); }
  }
  async function undo(): Promise<void> {
    if (!target || busy) return;
    setBusy(true); setError("");
    try {
      await undoSkillDefinitionRevision(cwd, skill.id, { revisionId: target.revision.id, expectedUpdatedAt: target.updatedAt,
        // The confirmation dialog shows all restored fields, including authority changes.
        confirmAuthorityChanges: true });
      if (!alive.current) return;
      setTarget(undefined); setRestored(true); await refresh(); await onChanged?.();
    } catch (caught) { if (alive.current) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { if (alive.current) setBusy(false); }
  }
  return <div className="skill-definition-history">
    <details onToggle={event => setOpened(event.currentTarget.open)}>
      <summary>{t("Definition history")}</summary>
      {restored ? <InlineFeedback tone="success">{t("Previous definition restored")}</InlineFeedback> : null}
      {revisions.map((revision, index) => <article key={revision.id}>
        <details><summary>#{revision.revision} · {revision.reason}</summary>
          <small>{revision.createdAt} · {revision.actor}</small>
          <p>{revision.validationStatus === "replayed" ? t("Verified by execution") : t("Not verified by execution")}</p>
          <SkillDefinitionDiff before={revision.beforeDefinition} after={revision.afterDefinition} />
          {index === 0 && editable && revision.kind === "edit" && revision.beforeDefinition ?
            <Button size="sm" leadingIcon={<RotateCcw size={14} />} disabled={busy} onClick={() => setTarget({ revision, updatedAt: skill.updatedAt })}>{t("Undo this change")}</Button> : null}
        </details>
      </article>)}
      {opened && revisions.length === 0 && !error ? <small>{t("No definition history yet")}</small> : null}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>{t("Refresh")}</Button>
    </details>
    {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
    <Dialog open={Boolean(target)} busy={busy} onOpenChange={open => { if (!open && !busy) setTarget(undefined); }}>
      <DialogContent size="lg" aria-label={t("Restore previous definition")}>
        <DialogHeader title={t("Restore previous definition")} description={t("This creates a new revision. Newer edits cause a conflict and are preserved.")} closeLabel={t("Close")} />
        <DialogBody>{target?.revision.beforeDefinition ? <SkillDefinitionDiff before={target.revision.afterDefinition} after={target.revision.beforeDefinition} /> : null}
          {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
        </DialogBody>
        <DialogFooter><Button disabled={busy} onClick={() => setTarget(undefined)}>{t("Cancel")}</Button>
          <Button variant="primary" loading={busy} onClick={() => void undo()}>{t("Restore previous definition")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
