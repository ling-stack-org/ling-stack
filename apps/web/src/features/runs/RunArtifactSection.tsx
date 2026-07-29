import { FileText } from "lucide-react";
import { useRef, useState } from "react";
import { useI18n } from "../../i18n.js";
import { fileChangeStatusFromRun } from "../../lib/file-change-evidence.js";
import { readRunWorkspaceCwd } from "../../lib/run-evidence.js";
import { ArtifactRow } from "../../shared/components/ArtifactRow.js";
import { FileChangeEvidencePanel } from "../../shared/conversation/index.js";
import { EmptyState, InlineFeedback, InspectorSection, OverlayPortalProvider } from "../../shared/ui/index.js";
import { previewArtifactContent } from "../../api.js";
import type { RunArtifact, RunEventEnvelope, RunSession } from "../../types.js";
import { RunSkillRecordingDialog } from "./RunSkillRecordingDialog.js";
import { useRunSkillRecording } from "./useRunSkillRecording.js";

export function RunArtifactSection({ cwd, run, events, artifacts }: {
  readonly cwd: string;
  readonly run: RunSession;
  readonly events: readonly RunEventEnvelope[];
  readonly artifacts: readonly RunArtifact[];
}): JSX.Element {
  const { t } = useI18n();
  const [overlayContainer, setOverlayContainer] = useState<HTMLDivElement | null>(null);
  const recordingTriggerRef = useRef<HTMLElement | null>(null);
  const artifactCwd = readRunWorkspaceCwd(run, run.cwd);
  const recording = useRunSkillRecording({ cwd: artifactCwd || cwd, run, events });
  return (
    <InspectorSection open={artifacts.length > 0} summary={t("{count} artifacts", { count: artifacts.length })} title={`${t("Artifacts")} · ${t("Workspace changes")}`}>
      <div className="runs-section-stack">
        <FileChangeEvidencePanel cwd={artifactCwd} artifacts={artifacts} status={fileChangeStatusFromRun(run)} loadArtifactPreview={previewArtifactContent} sourceRunId={run.id} />
        {artifacts.length === 0 ? <EmptyState compact icon={<FileText />} title={t("No artifacts recorded for this run")} description={t("Artifacts will appear here once the daemon records files under .ling-stack/artifacts.")} /> : (
          <div className="artifact-list">{artifacts.map((artifact) => <ArtifactRow artifact={artifact} cwd={artifactCwd} key={artifact.id} onUseAsSkillEvidence={recording.state.visible ? (selectedArtifact) => {
            recordingTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            recording.actions.openArtifact(selectedArtifact);
          } : undefined} />)}</div>
        )}
        {recording.state.precheckError ? <InlineFeedback tone="warning">{t("Using local recording precheck because daemon eligibility is unavailable.")}</InlineFeedback> : recording.state.precheck ? <InlineFeedback tone="info">{t("Daemon duplicate precheck completed without using a model call.")}</InlineFeedback> : null}
      </div>
      <div className="runs-local-overlay-root" ref={setOverlayContainer} />
      <OverlayPortalProvider container={overlayContainer}>
        <RunSkillRecordingDialog
          draft={recording.state.draft}
          error={recording.state.submitError}
          onChange={recording.actions.updateDraft}
          onClose={recording.actions.close}
          onSubmit={() => void recording.actions.submit()}
          precheckError={recording.state.precheckError}
          result={recording.state.result}
          returnFocusRef={recordingTriggerRef}
          submitting={recording.state.submitting}
        />
      </OverlayPortalProvider>
    </InspectorSection>
  );
}
