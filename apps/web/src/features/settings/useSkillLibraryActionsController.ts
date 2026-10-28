import { useState } from "react";
import {
  archiveSkill,
  archiveSkillSourceSnapshot,
  createChannelPlaybookCandidateFromCluster,
  createChannelProtocolCandidateFromCluster,
  createSkillCandidateDraft,
  getSkillCandidate,
  hardDeleteSkill,
  listSkills,
  previewSkillOptimization,
  reviewChannelPlaybookCandidate,
  reviewSkillCandidate,
  rollbackSkillSourceSnapshot,
} from "../../api.js";
import type { LingToastInput } from "../../shared/ui/index.js";
import type {
  ChannelPlaybookCandidate,
  ChannelPlaybookCandidateReviewAction,
  ProcedureObservationCluster,
  SkillCandidateReviewAction,
  SkillRegistryEntry,
} from "../../types.js";
import {
  playbookCandidateReviewMessage,
  playbookCandidateReviewReason,
  skillCandidateReviewMessage,
  skillCandidateReviewReason,
  type SettingsTranslator,
} from "./skill-library-utils.js";
import type { SkillLibraryDataController } from "./useSkillLibraryDataController.js";
import type { useSkillEditorController } from "./useSkillEditorController.js";

type SkillEditorController = ReturnType<typeof useSkillEditorController>;
type SkillActionScope = "registry" | "review" | "source";

export function useSkillLibraryActionsController({
  data,
  editor,
  showToast,
  t,
}: {
  readonly data: SkillLibraryDataController;
  readonly editor: SkillEditorController;
  readonly showToast: (input: LingToastInput) => string;
  readonly t: SettingsTranslator;
}) {
  const [busyAction, setBusyAction] = useState("");
  const [registryError, setRegistryError] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SkillRegistryEntry | undefined>();
  const [deleteError, setDeleteError] = useState("");

  function workspaceCwd(scope: SkillActionScope): string | undefined {
    if (data.cwd) return data.cwd;
    setScopedError(scope, t("Workspace path is required."));
    return undefined;
  }

  function setScopedError(scope: SkillActionScope, message: string): void {
    if (scope === "review") setReviewError(message);
    else if (scope === "source") setSourceError(message);
    else setRegistryError(message);
  }

  function clearScopedError(scope: SkillActionScope): void {
    setScopedError(scope, "");
  }

  function success(message: string, scope: string): void {
    showToast({ message, scope, tone: "success" });
  }

  async function previewSelectedSkillOptimization(): Promise<void> {
    const skill = data.selectedSkill;
    const cwd = workspaceCwd("source");
    if (!skill || !cwd || busyAction) return;
    const action = `source-preview:${skill.id}`;
    setBusyAction(action);
    clearScopedError("source");
    try {
      const response = await previewSkillOptimization(cwd, skill.id, { mode: "preview_on_demand" });
      data.setSkillOptimizationPreview(response.preview);
      success(t("Optimization preview ready"), `skill:${skill.id}:optimization-preview`);
    } catch (error) {
      setScopedError("source", errorMessage(error));
    } finally {
      setBusyAction("");
    }
  }

  async function rollbackSelectedSkillSource(snapshotId: string): Promise<void> {
    const skill = data.selectedSkill;
    const cwd = workspaceCwd("source");
    if (!skill || !cwd || busyAction) return;
    setBusyAction(`source-rollback:${snapshotId}`);
    clearScopedError("source");
    try {
      await rollbackSkillSourceSnapshot(cwd, skill.id, { snapshotId });
      await data.refresh();
      success(t("Source snapshot rolled back"), `skill:${skill.id}:source-rollback`);
    } catch (error) {
      setScopedError("source", errorMessage(error));
    } finally {
      setBusyAction("");
    }
  }

  async function archiveSourceSnapshot(skillId: string): Promise<void> {
    const cwd = workspaceCwd("source");
    if (!cwd || busyAction) return;
    setBusyAction(`source-archive:${skillId}`);
    clearScopedError("source");
    try {
      await archiveSkillSourceSnapshot(cwd, skillId);
      await data.refresh();
      success(t("Source snapshot archived"), `skill:${skillId}:source-archive`);
    } catch (error) {
      setScopedError("source", errorMessage(error));
    } finally {
      setBusyAction("");
    }
  }

  async function reviewCandidate(candidateId: string, action: SkillCandidateReviewAction): Promise<void> {
    const cwd = workspaceCwd("review");
    if (!cwd || busyAction) return;
    setBusyAction(`candidate:${candidateId}:${action}`);
    clearScopedError("review");
    try {
      const response = await reviewSkillCandidate(cwd, candidateId, {
        action,
        reason: skillCandidateReviewReason(action, t),
      });
      data.setSkillCandidates((current) => current.map((candidate) => candidate.id === candidateId ? response.candidate : candidate));
      await data.refresh();
      if (action === "reject") data.setEvolutionView("ignored");
      success(skillCandidateReviewMessage(action, t), `skill-candidate:${candidateId}:${action}`);
    } catch (error) {
      setScopedError("review", errorMessage(error));
    } finally {
      setBusyAction("");
    }
  }

  async function adoptCandidate(candidateId: string): Promise<void> {
    const cwd = workspaceCwd("review");
    if (!cwd || busyAction) return;
    setBusyAction(`candidate:${candidateId}:adopt`);
    clearScopedError("review");
    try {
      const candidate = data.skillCandidates.find((item) => item.id === candidateId) ?? (await getSkillCandidate(cwd, candidateId)).candidate;
      if (!candidate) throw new Error(t("Skill candidate not found."));
      if (candidate.status !== "approved_for_draft") {
        const review = await reviewSkillCandidate(cwd, candidateId, {
          action: "approve_for_draft",
          reason: skillCandidateReviewReason("approve_for_draft", t),
        });
        data.setSkillCandidates((current) => current.map((item) => item.id === candidateId ? review.candidate : item));
      }
      if (candidate.proposedAction === "update_existing" && candidate.targetSkillId && candidate.definition.skillDefinition) {
        const target = data.skills.find(skill => skill.id === candidate.targetSkillId);
        if (!target) throw new Error(t("Skill candidate not found."));
        editor.openCandidateRevision(candidate, target);
      } else {
        const response = await createSkillCandidateDraft(cwd, candidateId);
        editor.openCandidate(response.draft, candidateId);
      }
    } catch (error) {
      setScopedError("review", errorMessage(error));
    } finally {
      setBusyAction("");
    }
  }

  async function createProtocolCandidate(cluster: ProcedureObservationCluster): Promise<void> {
    await createClusterCandidate(cluster, "protocol");
  }

  async function createPlaybookCandidate(cluster: ProcedureObservationCluster): Promise<void> {
    await createClusterCandidate(cluster, "playbook");
  }

  async function createClusterCandidate(cluster: ProcedureObservationCluster, kind: "protocol" | "playbook"): Promise<void> {
    const cwd = workspaceCwd("review");
    if (!cwd || busyAction) return;
    if (!cluster.channelId) {
      setScopedError("review", t("Candidate cluster is not bound to a channel."));
      return;
    }
    setBusyAction(`cluster:${cluster.id}:${kind}`);
    clearScopedError("review");
    try {
      if (kind === "protocol") await createChannelProtocolCandidateFromCluster(cwd, cluster.channelId, cluster.id);
      else await createChannelPlaybookCandidateFromCluster(cwd, cluster.channelId, cluster.id);
      await data.refresh();
      success(
        t(kind === "protocol" ? "Protocol candidate created" : "Playbook candidate created"),
        `skill-cluster:${cluster.id}:${kind}`,
      );
    } catch (error) {
      setScopedError("review", errorMessage(error));
    } finally {
      setBusyAction("");
    }
  }

  async function reviewPlaybook(candidate: ChannelPlaybookCandidate, action: ChannelPlaybookCandidateReviewAction): Promise<void> {
    const cwd = workspaceCwd("review");
    if (!cwd || busyAction) return;
    setBusyAction(`playbook:${candidate.id}:${action}`);
    clearScopedError("review");
    try {
      const response = await reviewChannelPlaybookCandidate(cwd, candidate.channelId, candidate.id, {
        action,
        reason: playbookCandidateReviewReason(action, t),
      });
      data.setPlaybookCandidates((current) => current.map((item) => item.id === candidate.id ? response.candidate : item));
      await data.refresh();
      data.setEvolutionView(action === "reject" ? "ignored" : "generated");
      success(playbookCandidateReviewMessage(action, t), `skill-playbook:${candidate.id}:${action}`);
    } catch (error) {
      setScopedError("review", errorMessage(error));
    } finally {
      setBusyAction("");
    }
  }

  async function archiveRegistrySkill(skillId: string): Promise<void> {
    const cwd = workspaceCwd("registry");
    if (!cwd || busyAction) return;
    setBusyAction(`archive:${skillId}`);
    clearScopedError("registry");
    try {
      await archiveSkill(cwd, skillId);
      await data.refresh();
      success(t("Skill archived"), `skill:${skillId}:archive`);
    } catch (error) {
      setScopedError("registry", errorMessage(error));
    } finally {
      setBusyAction("");
    }
  }

  function requestDeleteSkill(skill: SkillRegistryEntry): void {
    if (busyAction) return;
    setDeleteTarget(skill);
    setDeleteError("");
  }

  function closeDeleteDialog(): void {
    if (busyAction.startsWith("delete:")) return;
    setDeleteTarget(undefined);
    setDeleteError("");
  }

  async function confirmDeleteSkill(): Promise<void> {
    const skill = deleteTarget;
    const cwd = data.cwd;
    if (!skill || !cwd || busyAction) return;
    setBusyAction(`delete:${skill.id}`);
    setDeleteError("");
    try {
      await hardDeleteSkill(cwd, skill.id);
      if (data.selectedSkillId === skill.id) data.setSelectedSkillId("");
      await data.refresh();
      setDeleteTarget(undefined);
      success(t("Skill deleted"), `skill:${skill.id}:delete`);
    } catch (error) {
      setDeleteError(hardDeleteSkillErrorMessage(error, t));
    } finally {
      setBusyAction("");
    }
  }

  async function reloadSkillEditorRevision(): Promise<void> {
    const skillId = editor.skill?.id;
    if (!skillId || busyAction) return;
    setBusyAction(`reload:${skillId}`);
    clearScopedError("registry");
    try {
      const response = await listSkills(data.cwd);
      data.setSkills(response.skills);
      const latest = response.skills.find((entry) => entry.id === skillId);
      if (!latest) throw new Error(t("Skill not found."));
      editor.reloadRevision(latest);
    } catch (error) {
      setScopedError("registry", errorMessage(error));
    } finally {
      setBusyAction("");
    }
  }

  return {
    busyAction,
    registryError,
    reviewError,
    sourceError,
    deleteTarget,
    deleteError,
    previewSelectedSkillOptimization,
    rollbackSelectedSkillSource,
    archiveSourceSnapshot,
    reviewCandidate,
    adoptCandidate,
    createProtocolCandidate,
    createPlaybookCandidate,
    reviewPlaybook,
    archiveRegistrySkill,
    requestDeleteSkill,
    closeDeleteDialog,
    confirmDeleteSkill,
    reloadSkillEditorRevision,
  } as const;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hardDeleteSkillErrorMessage(error: unknown, t: SettingsTranslator): string {
  const message = errorMessage(error);
  if (message.includes("skill_delete_not_imported")) return t("Only manually imported skills can be deleted.");
  if (message.includes("skill_delete_blocked")) {
    return t("This skill is still in use. Remove its teammate bindings or active work references first.");
  }
  return message;
}
