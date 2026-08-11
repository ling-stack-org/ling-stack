import { useEffect, useRef } from "react";
import { BookOpen, X } from "lucide-react";
import { IconButton } from "../../shared/ui/index.js";
import type {
  SkillOptimizationPreview,
  SkillRegistryEntry,
  SkillSourceArtifact,
  SkillSourceSnapshot,
} from "../../types.js";
import { SkillCompactInspector } from "./SkillCompactInspector.js";
import type { SettingsTranslator } from "./skill-library-utils.js";

export function SkillLibraryInspectorPanel({
  skill,
  readOnly,
  sourceSnapshot,
  sourceHistory,
  artifacts,
  sourceArtifactsLoading,
  sourceError,
  optimizationPreview,
  busyAction,
  cwd,
  boundTeammates,
  editable,
  onClose,
  onEdit,
  onPreviewOptimization,
  onArchiveSource,
  onRollbackSource,
  t,
}: {
  readonly skill: SkillRegistryEntry;
  readonly readOnly: boolean;
  readonly sourceSnapshot: SkillSourceSnapshot | undefined;
  readonly sourceHistory: readonly SkillSourceSnapshot[];
  readonly artifacts: readonly SkillSourceArtifact[];
  readonly sourceArtifactsLoading: boolean;
  readonly sourceError: string;
  readonly optimizationPreview: SkillOptimizationPreview | undefined;
  readonly busyAction: string;
  readonly cwd: string;
  readonly boundTeammates: readonly string[];
  readonly editable: boolean;
  readonly onClose: () => void;
  readonly onEdit: () => void;
  readonly onPreviewOptimization: () => void;
  readonly onArchiveSource: () => void;
  readonly onRollbackSource: (snapshotId: string) => void;
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (document.activeElement instanceof HTMLElement) triggerRef.current = document.activeElement;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAndRestoreFocus();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  function closeAndRestoreFocus(): void {
    const trigger = triggerRef.current;
    onClose();
    globalThis.requestAnimationFrame(() => trigger?.focus());
  }

  return (
    <aside className="settings-skill-detail-drawer" aria-label={t("Skill detail")} data-ui2-skill-inspector="">
      <div className="settings-skill-inspector-head">
        <span>
          <BookOpen size={15} />
          <strong>{skill.definition.name}</strong>
        </span>
        <IconButton icon={X} label={t("Close")} size="sm" onClick={closeAndRestoreFocus} />
      </div>
      <div className="settings-skill-inspector-body">
        <SkillCompactInspector
          skill={skill}
          readOnly={readOnly}
          sourceSnapshot={sourceSnapshot}
          sourceHistory={sourceHistory}
          artifacts={artifacts}
          sourceArtifactsLoading={sourceArtifactsLoading}
          sourceError={sourceError}
          optimizationPreview={optimizationPreview}
          busyAction={busyAction}
          cwd={cwd}
          boundTeammates={boundTeammates}
          editable={editable}
          onEdit={onEdit}
          onPreviewOptimization={onPreviewOptimization}
          onArchiveSource={onArchiveSource}
          onRollbackSource={onRollbackSource}
          t={t}
        />
      </div>
    </aside>
  );
}
