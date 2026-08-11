import { Button, SegmentedControl, SegmentedControlItem } from "../../shared/ui/index.js";
import { Clapperboard, ListChecks, ListVideo, PanelsTopLeft, Play, Settings2 } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { MediaProductionView } from "./media-production-types.js";
import {
  deriveMediaProductionToolbarProjection,
  isMediaProductionView,
  type MediaProductionToolbarActionProjection,
  type TranslationDescriptor,
} from "./media-production-canvas-view-models.js";

export function MediaProductionCanvasToolbar({
  projectName,
  sceneCount,
  view,
  readyCount,
  hasGenerationSource,
  busy,
  onViewChange,
  onOpenProjectDock,
  onRunProject,
  onConfigureVideoModel,
}: {
  readonly projectName?: string;
  readonly sceneCount: number;
  readonly view: MediaProductionView;
  readonly readyCount: number;
  readonly hasGenerationSource: boolean;
  readonly busy: boolean;
  readonly onViewChange: (view: MediaProductionView) => void;
  readonly onOpenProjectDock: () => void;
  readonly onRunProject: () => void;
  readonly onConfigureVideoModel: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const projection = deriveMediaProductionToolbarProjection({
    projectName,
    sceneCount,
    view,
    readyCount,
    hasGenerationSource,
    runBusy: busy,
  });
  return (
    <nav
      className="media-production-canvas-toolbar"
      aria-label={t("Media production views")}
      data-desktop-window-drag-region="true"
    >
      <Button
        className="media-production-project-trigger"
        size="sm"
        variant="ghost"
        leadingIcon={<PanelsTopLeft aria-hidden="true" />}
        onClick={onOpenProjectDock}
        title={projection.projectName ?? t("Projects and scenes")}
      >
        <span>{projection.projectName ?? translateDescriptor(t, projection.projectLabel)}</span>
        {projection.sceneCountLabel ? <small>{translateDescriptor(t, projection.sceneCountLabel)}</small> : null}
      </Button>
      <span className="media-production-toolbar-divider" aria-hidden="true" />
      <SegmentedControl
        className="media-production-view-switcher"
        size="sm"
        value={view}
        aria-label={t("Media production views")}
        onValueChange={(nextView) => {
          if (isMediaProductionView(nextView)) onViewChange(nextView);
        }}
      >
        <SegmentedControlItem value="studio">
          <Clapperboard aria-hidden="true" /> {t("Production studio")}
        </SegmentedControlItem>
        <SegmentedControlItem value="jobs">
          <ListVideo aria-hidden="true" /> {t("Generation tasks")}
        </SegmentedControlItem>
      </SegmentedControl>
      {projection.action.kind !== "none" ? (
        <>
          <span className="media-production-toolbar-divider" aria-hidden="true" />
          <ToolbarPrimaryAction
            action={projection.action}
            onConfigure={onConfigureVideoModel}
            onReviewOrRun={onRunProject}
          />
        </>
      ) : null}
    </nav>
  );
}

function ToolbarPrimaryAction({
  action,
  onConfigure,
  onReviewOrRun,
}: {
  readonly action: MediaProductionToolbarActionProjection;
  readonly onConfigure: () => void;
  readonly onReviewOrRun: () => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  if (action.kind === "none") return null;
  const icon = action.kind === "configure"
    ? <Settings2 aria-hidden="true" />
    : action.kind === "review"
      ? <ListChecks aria-hidden="true" />
      : <Play aria-hidden="true" />;
  return (
    <Button
      className="media-production-primary-action"
      size="sm"
      variant={action.kind === "run" ? "primary" : "secondary"}
      leadingIcon={icon}
      loading={action.busy}
      loadingLabel={t("Generating")}
      onClick={action.kind === "configure" ? onConfigure : onReviewOrRun}
    >
      {translateDescriptor(t, action.label)}
      {action.countLabel ? <> · {translateDescriptor(t, action.countLabel)}</> : null}
    </Button>
  );
}

function translateDescriptor(
  translate: (key: string, values?: Readonly<Record<string, string | number>>) => string,
  descriptor: TranslationDescriptor,
): string {
  return translate(descriptor.key, descriptor.values);
}
