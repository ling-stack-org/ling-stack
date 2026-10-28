import { useRef } from "react";
import { useI18n } from "../../i18n.js";
import { InlineFeedback, useLingToast } from "../../shared/ui/index.js";
import type { SkillRegistryEntry } from "../../types.js";
import { SkillDeleteDialog } from "./SkillDeleteDialog.js";
import { SkillEditorDialog } from "./SkillEditorDialog.js";
import { SkillEvolutionSection } from "./SkillEvolutionSection.js";
import { SkillImportDialog } from "./SkillImportDialog.js";
import { SkillLibraryNavigation } from "./SkillLibraryNavigation.js";
import { SkillLibraryRegistrySection } from "./SkillLibraryRegistrySection.js";
import { useSkillEditorController } from "./useSkillEditorController.js";
import { useSkillImportController } from "./useSkillImportController.js";
import { useSkillLibraryActionsController } from "./useSkillLibraryActionsController.js";
import { useSkillLibraryDataController } from "./useSkillLibraryDataController.js";
import { isEvolvedSkillEntry } from "./skill-editor-utils.js";
import { LearningReviewDisclosure } from "../../shared/components/learning/LearningReviewPanel.js";

export function SkillLibrarySettingsPanel({
  cwd,
  refreshToken = 0,
}: {
  readonly cwd: string;
  readonly refreshToken?: number;
}): React.JSX.Element {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const data = useSkillLibraryDataController({ cwd, refreshToken, t });
  const skillImport = useSkillImportController({
    cwd,
    t,
    onSuccess: (message) => showToast({ message, scope: "skill:import", tone: "success" }),
    onPublished: async (publishedSkills) => {
      await data.refresh();
      data.changeSection("mine");
      data.setSelectedSkillId(publishedSkills[0]?.id ?? "");
    },
  });
  const skillEditor = useSkillEditorController({
    cwd,
    t,
    onSuccess: (message) => showToast({ message, scope: "skill:editor", tone: "success" }),
    onCompleted: async ({ skills, candidateId, mode }) => {
      await data.refresh();
      if (mode === "revision" && skills[0]) {
        const evolved = isEvolvedSkillEntry(skills[0]);
        data.changeSection(evolved ? "evolution" : "mine");
        if (evolved) data.setEvolutionView("generated");
        data.setSelectedSkillId(skills[0].id);
      } else if (candidateId || mode === "candidate") {
        data.changeSection("evolution");
        data.setEvolutionView("generated");
        data.setSelectedSkillId(skills[0]?.id ?? "");
      } else {
        data.changeSection("mine");
        data.setSelectedSkillId(skills[0]?.id ?? "");
      }
    },
  });
  const actions = useSkillLibraryActionsController({ data, editor: skillEditor, showToast, t });

  const commonRegistryProps = {
    skills: data.skills,
    loading: data.loading,
    busyAction: actions.busyAction,
    selectedSkillId: data.selectedSkill?.id,
    bindingSummaries: data.bindingSummaries,
    sourceSnapshotBySkillId: data.sourceSnapshotBySkillId,
    sourceHistoryBySkillId: data.sourceSnapshotHistoryBySkillId,
    artifacts: data.skillSourceArtifacts,
    sourceArtifactsLoading: data.sourceArtifactsLoading,
    sourceError: actions.sourceError || data.sourceArtifactError,
    optimizationPreview: data.skillOptimizationPreview,
    cwd: data.cwd,
    onSelectSkill: data.setSelectedSkillId,
    onArchiveSkill: actions.archiveRegistrySkill,
    onDeleteSkill: (skill: SkillRegistryEntry, trigger: HTMLButtonElement) => {
      deleteTriggerRef.current = trigger;
      actions.requestDeleteSkill(skill);
    },
    onEditSkill: skillEditor.openRevision,
    onPreviewOptimization: actions.previewSelectedSkillOptimization,
    onArchiveSource: actions.archiveSourceSnapshot,
    onRollbackSource: actions.rollbackSelectedSkillSource,
    onDefinitionChanged: async () => { await data.refresh(); },
    t,
  } as const;

  return (
    <section
      className={data.activeSubsection === "evolution"
        ? "settings-skill-library settings-skill-library--evolution"
        : "settings-skill-library settings-skill-library--skills"}
      aria-label={t("Skill library")}
      data-ui2-skill-library=""
    >
      <SkillLibraryNavigation
        activeSection={data.activeSubsection}
        currentUserCount={data.currentUserCount}
        evolutionCount={data.evolutionCount}
        builtinCount={data.ownershipPartition.builtin.length}
        onSectionChange={data.changeSection}
      />

      {data.loadError ? <InlineFeedback tone="danger">{data.loadError}</InlineFeedback> : null}
      {actions.registryError ? <InlineFeedback tone="danger">{actions.registryError}</InlineFeedback> : null}
      {data.activeSubsection === "evolution" ? <LearningReviewDisclosure cwd={cwd} onReviewCandidate={actions.adoptCandidate} /> : null}

      {data.activeSubsection === "evolution" ? (
        <SkillEvolutionSection
          {...commonRegistryProps}
          view={data.evolutionView}
          skillCandidates={data.skillCandidates}
          clusters={data.observationClusters}
          playbookCandidates={data.playbookCandidates}
          channels={data.channels}
          reviewError={actions.reviewError}
          onViewChange={data.changeEvolutionView}
          onAdoptSkillCandidate={actions.adoptCandidate}
          onReviewSkillCandidate={actions.reviewCandidate}
          onCreateProtocolCandidate={actions.createProtocolCandidate}
          onCreatePlaybookCandidate={actions.createPlaybookCandidate}
          onReviewPlaybookCandidate={actions.reviewPlaybook}
        />
      ) : (
        <SkillLibraryRegistrySection
          {...commonRegistryProps}
          mode={data.activeSubsection === "mine" ? "user" : "builtin"}
          onImport={skillImport.openImport}
          onNewDraft={skillEditor.openCreate}
        />
      )}

      <SkillImportDialog
        open={skillImport.open}
        form={skillImport.form}
        busy={skillImport.busy}
        error={skillImport.error}
        blockingIssues={skillImport.blockingIssues}
        onClose={skillImport.closeImport}
        onLoadFile={(file) => void skillImport.loadFile(file)}
        onImport={() => void skillImport.importFile()}
        t={t}
      />

      <SkillEditorDialog
        open={skillEditor.open}
        mode={skillEditor.mode}
        sourceKind={skillEditor.sourceKind}
        form={skillEditor.form}
        dirty={skillEditor.dirty}
        busy={skillEditor.busy}
        error={skillEditor.error}
        conflict={skillEditor.conflict}
        preview={skillEditor.preview}
        beforeDefinition={skillEditor.skill?.definition}
        authorityConfirmation={skillEditor.authorityConfirmation}
        discardConfirmation={skillEditor.discardConfirmation}
        onFormChange={skillEditor.setForm}
        onClose={skillEditor.requestClose}
        onDiscard={skillEditor.discardChanges}
        onContinueEditing={skillEditor.continueEditing}
        onSave={() => void skillEditor.save()}
        onConfirmAuthorityChanges={() => void skillEditor.confirmAuthorityChanges()}
        onReload={() => void actions.reloadSkillEditorRevision()}
        t={t}
      />

      <SkillDeleteDialog
        target={actions.deleteTarget}
        busy={actions.busyAction === `delete:${actions.deleteTarget?.id ?? ""}`}
        error={actions.deleteError}
        returnFocusRef={deleteTriggerRef}
        onClose={actions.closeDeleteDialog}
        onConfirm={() => void actions.confirmDeleteSkill()}
        t={t}
      />
    </section>
  );
}
