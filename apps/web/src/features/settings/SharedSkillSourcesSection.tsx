import { useState } from "react";
import { FolderSearch, RefreshCw } from "lucide-react";
import {
  Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, EmptyState, InlineFeedback, Skeleton,
} from "../../shared/ui/index.js";
import type { SkillSourceScanRoot, SkillSourceSyncPreviewRecord } from "../../types.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import {
  canIgnoreSharedSkill, canPublishSharedSkill, sharedSkillSourceKey, sharedSkillSourceLocation, sharedSkillSourceRootLabel, sharedSkillSourceStatus,
  visibleSharedSkillSourceRecords,
} from "./shared-skill-sources-model.js";
import type { SharedSkillSourcesController } from "./useSharedSkillSourcesController.js";

export function SharedSkillSourcesSection({ controller, t }: {
  readonly controller: SharedSkillSourcesController;
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  const [showIgnored, setShowIgnored] = useState(false);
  const [showOrphaned, setShowOrphaned] = useState(false);
  const roots = controller.response?.preview.roots ?? [];
  const visible = visibleSharedSkillSourceRecords(controller.records, controller.ignored, { showIgnored, showOrphaned });
  const ignoredCount = controller.records.filter((record) => controller.ignored.has(sharedSkillSourceKey(record))).length;
  const orphanedCount = controller.records.filter((record) => record.state === "orphaned").length;
  return (
    <section className="settings-shared-skills" aria-label={t("Local skill folders")} data-ui2-shared-skills="">
      <header className="settings-shared-skills-header">
        <div>
          <h2>{t("Local skill folders")}</h2>
          <p>{t("Discover skills in the project and user .agents/skills folders. Review each source before adding or updating it.")}</p>
        </div>
        <Button size="sm" variant="secondary" leadingIcon={<RefreshCw size={14} />} loading={controller.loading}
          onClick={() => void controller.refresh()}>{t("Scan folders")}</Button>
      </header>
      {controller.error ? <InlineFeedback tone="danger">{controller.error}</InlineFeedback> : null}
      {roots.length > 0 ? (
        <div className="settings-shared-skills-roots">
          {roots.map((root, index) => <span key={root.id ?? index}>{sharedSkillSourceRootLabel(root)}</span>)}
        </div>
      ) : null}
      <div className="settings-shared-skills-toolbar">
        <span>{t("{count} ready to review", { count: controller.actionableCount })}</span>
        <div>
          {ignoredCount > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setShowIgnored((current) => !current)}>
              {showIgnored ? t("Hide ignored") : t("Show ignored ({count})", { count: ignoredCount })}
            </Button>
          ) : null}
          {orphanedCount > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setShowOrphaned((current) => !current)}>
              {showOrphaned ? t("Hide orphaned") : t("Show orphaned ({count})", { count: orphanedCount })}
            </Button>
          ) : null}
          <Button size="sm" variant="primary" disabled={controller.selectedRecords.length === 0 || controller.publishing}
            onClick={() => controller.requestPublish()}>
            {t("Add or update selected ({count})", { count: controller.selectedRecords.length })}
          </Button>
        </div>
      </div>
      {controller.loading && !controller.response ? (
        <div className="settings-shared-skills-list" role="status" aria-label={t("Scanning skill folders...")}>
          {[0, 1, 2].map((index) => <Skeleton key={index} shape="block" height={84} width="100%" />)}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState compact icon={<FolderSearch size={18} />}
          title={controller.records.length === 0 ? t("No local skill folders found") : orphanedCount > 0 && !showOrphaned && ignoredCount === 0 ? t("Only orphaned sources remain") : t("All discovered skills are ignored")}
          description={controller.records.length === 0
            ? t("Add a SKILL.md under the project or user .agents/skills folder, then scan again.")
            : orphanedCount > 0 && !showOrphaned && ignoredCount === 0
               ? t("Show orphaned sources to inspect a snapshot without a matching active skill.")
               : t("Show ignored skills to restore a candidate.")} />
      ) : (
        <div className="settings-shared-skills-list">
          {visible.map((record) => <SharedSkillSourceCard key={sharedSkillSourceKey(record)} record={record} roots={roots} controller={controller} t={t} />)}
        </div>
      )}
      <Dialog open={controller.confirming} busy={controller.publishing} onOpenChange={(open) => { if (!open) controller.setConfirming(false); }}>
        <DialogContent size="sm" data-ui2-shared-skill-confirm="">
          <DialogHeader title={t("Confirm skill publication")} closeLabel={t("Close confirmation")} />
          <DialogBody>
            <p>{t("Publish {count} selected skill sources to this workspace?", { count: controller.selectedRecords.length })}</p>
            <ul>{controller.selectedRecords.map((record) => <li key={sharedSkillSourceKey(record)}>{record.frontMatter?.name ?? record.skillId} · {t(sharedSkillStatusKey(record.state))}</li>)}</ul>
            {controller.hasNewSkills ? (
              <label className="settings-shared-skills-new-confirm">
                <input type="checkbox" data-ling-control-native="true" checked={controller.confirmNew} onChange={(event) => controller.setConfirmNew(event.target.checked)} />
                {t("I confirm adding new skills to this workspace")}
              </label>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button size="sm" variant="secondary" disabled={controller.publishing} onClick={() => controller.setConfirming(false)}>{t("Cancel")}</Button>
            <Button size="sm" variant="primary" loading={controller.publishing}
              disabled={controller.selectedRecords.length === 0 || (controller.hasNewSkills && !controller.confirmNew)}
              onClick={() => void controller.publish()}>{t("Publish selected")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function SharedSkillSourceCard({ record, roots, controller, t }: {
  readonly record: SkillSourceSyncPreviewRecord;
  readonly roots: readonly SkillSourceScanRoot[];
  readonly controller: SharedSkillSourcesController;
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  const key = sharedSkillSourceKey(record);
  const ignored = controller.ignored.has(key);
  const status = sharedSkillSourceStatus(record, controller.ignored);
  const publishable = canPublishSharedSkill(record) && !ignored;
  const root = roots.find((item) => item.id === record.sourceRootId);
  const label = record.frontMatter?.name ?? record.definitionPreview?.name ?? record.skillId;
  return (
    <article className="settings-shared-skills-card" data-state={status}>
      <div className="settings-shared-skills-card-head">
        {publishable ? <input type="checkbox" data-ling-control-native="true" aria-label={t("Select {name}", { name: label })}
          checked={controller.selected.has(key)} onChange={() => controller.toggleSelected(record)} /> : null}
        <div className="settings-shared-skills-card-title">
          <strong>{label}</strong>
          <small>{sharedSkillSourceRootLabel(root)} · {sharedSkillSourceLocation(record, roots)}</small>
        </div>
        <span className="settings-shared-skills-status">{t(sharedSkillStatusKey(status))}</span>
      </div>
      <p>{record.frontMatter?.description ?? record.definitionPreview?.summary ?? t("No description")}</p>
      <div className="settings-shared-skills-card-actions">
        <details>
          <summary>{t("View source and changes")}</summary>
          {record.diff.length > 0 ? <ul>{record.diff.map((item, index) => <li key={`${item.field}:${index}`}>{item.label} ({item.severity})</li>)}</ul> : null}
          {record.semanticDiff.length > 0 ? <ul>{record.semanticDiff.map((item, index) => <li key={`${item.kind}:${index}`}>{item.severity}: {item.message}</li>)}</ul> : null}
          {record.contextFindings.length > 0 ? <ul>{record.contextFindings.map((item, index) => <li key={index}>{item.message}</li>)}</ul> : null}
          {record.warnings.length > 0 ? <ul>{record.warnings.map((item, index) => <li key={`${item.code}:${index}`}>{item.severity}: {item.message}</li>)}</ul> : null}
          <section className="settings-shared-skills-file-inventory" aria-label={t("Referenced files")}>
            <h4>{t("Referenced files")}</h4>
            {record.referencedFiles.length > 0 ? (
              <ul>
                {record.referencedFiles.map((file) => (
                  <li key={`${file.path}:${file.checksum ?? ""}`}>
                    <code>{file.path}</code> · {file.kind} · {file.sizeBytes === undefined ? t("Size unknown") : t("{size} bytes", { size: file.sizeBytes })} · {file.checksum ?? t("Checksum unavailable")} · {file.includedInSnapshot ? t("Included") : t("Deferred")}
                  </li>
                ))}
              </ul>
            ) : <p>{t("No referenced files")}</p>}
          </section>
          {record.snapshotPreview?.rawSkillMarkdown ? <pre>{record.snapshotPreview.rawSkillMarkdown}</pre> : <p>{t("Source preview unavailable")}</p>}
        </details>
        {publishable ? <Button size="sm" variant="secondary" onClick={() => controller.requestPublish(record)}>
          {t(record.state === "drifted" ? "Update skill" : "Add skill")}</Button> : null}
        {(canIgnoreSharedSkill(record) || ignored) ? (
          <Button size="sm" variant="ghost" onClick={() => controller.ignore(record)}>
            {t(ignored ? "Restore" : "Ignore")}</Button>
        ) : null}
      </div>
    </article>
  );
}

function sharedSkillStatusKey(status: string): string {
  switch (status) {
    case "new": return "New skill";
    case "attachable": return "Ready to attach";
    case "drifted": return "Update available";
    case "unchanged": return "Up to date";
    case "missing": return "Source missing";
    case "blocked": return "Blocked";
    case "orphaned": return "Orphaned source";
    case "ignored": return "Ignored";
    default: return status;
  }
}
