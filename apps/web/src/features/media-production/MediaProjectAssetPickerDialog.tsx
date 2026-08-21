import { ImageIcon, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { artifactContentUrl } from "../../api.js";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  IconButton,
  InlineFeedback,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../shared/ui/index.js";
import type { MediaProjectAsset, MediaScene, RunArtifact } from "../../types.js";
import { mediaProjectAssetContentUrl } from "../../api/media-production.js";
import type { MediaProductionActions, MediaProductionFailure } from "./media-production-types.js";

export function MediaProjectAssetPickerDialog({
  open,
  mode,
  cwd,
  assets,
  scenes,
  imageArtifacts,
  initialSelectedIds,
  maxSelection,
  projectId,
  actions,
  onClose,
  onConfirm,
}: {
  readonly open: boolean;
  readonly mode: "library" | "choose-first-frame";
  readonly cwd: string;
  readonly assets: readonly MediaProjectAsset[];
  readonly scenes: readonly MediaScene[];
  readonly imageArtifacts: readonly RunArtifact[];
  readonly initialSelectedIds: readonly string[];
  readonly maxSelection: number;
  readonly projectId: string;
  readonly actions: MediaProductionActions;
  readonly onClose: () => void;
  readonly onConfirm: (assetIds: readonly string[]) => Promise<void>;
}): React.JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<"project" | "generated">("project");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set(initialSelectedIds));
  const [importingArtifactId, setImportingArtifactId] = useState("");
  const [deletingAssetId, setDeletingAssetId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<MediaProductionFailure>();
  const initialSelectionSignature = initialSelectedIds.join("\u0000");
  const visibleAssets = mode === "choose-first-frame"
    ? assets.filter((asset) => initialSelectedIds.includes(asset.id))
    : assets;
  const usageByAssetId = useMemo(() => new Map(assets.map((asset) => [
    asset.id,
    scenes.filter((scene) => scene.videoImageInputs.some((input) => input.assetId === asset.id)).length,
  ])), [assets, scenes]);
  const busy = Boolean(importingArtifactId || deletingAssetId || confirming);

  useEffect(() => {
    if (!open) return;
    setTab("project");
    setSelectedIds(new Set(initialSelectedIds));
    setImportingArtifactId("");
    setDeletingAssetId("");
    setConfirming(false);
    setFailure(undefined);
  }, [initialSelectionSignature, open]);

  const select = (assetId: string): void => {
    if (busy) return;
    setFailure(undefined);
    setSelectedIds((current) => {
      if (current.has(assetId)) {
        const next = new Set(current);
        next.delete(assetId);
        return next;
      }
      if (maxSelection === 1) return new Set([assetId]);
      if (current.size >= maxSelection) return current;
      return new Set([...current, assetId]);
    });
  };

  const importArtifact = async (artifact: RunArtifact): Promise<void> => {
    if (busy || (maxSelection > 1 && selectedIds.size >= maxSelection && !assets.some((asset) => asset.sourceArtifactId === artifact.id && selectedIds.has(asset.id)))) return;
    const existing = assets.find((asset) => asset.sourceArtifactId === artifact.id);
    if (existing) {
      select(existing.id);
      return;
    }
    setFailure(undefined);
    setImportingArtifactId(artifact.id);
    const outcome = await actions.createProjectAsset(projectId, { kind: "artifact", artifactId: artifact.id });
    setImportingArtifactId("");
    if (!outcome.ok) {
      setFailure(outcome.failure);
      return;
    }
    setSelectedIds((current) => maxSelection === 1 ? new Set([outcome.value.id]) : new Set([...current, outcome.value.id]));
  };

  const deleteAsset = async (assetId: string): Promise<void> => {
    if (busy) return;
    setFailure(undefined);
    setDeletingAssetId(assetId);
    const outcome = await actions.deleteProjectAsset(assetId);
    setDeletingAssetId("");
    if (!outcome.ok) {
      setFailure(outcome.failure);
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      next.delete(assetId);
      return next;
    });
  };

  const confirm = async (): Promise<void> => {
    if (busy || selectedIds.size === 0 || selectedIds.size > maxSelection) return;
    setConfirming(true);
    await onConfirm([...selectedIds]);
    setConfirming(false);
  };

  const title = mode === "choose-first-frame" ? t("Choose a starting frame") : t("Choose project images");
  return (
    <Dialog busy={busy} open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent className="media-project-asset-picker-dialog" size="lg" aria-label={title} data-media-production-dialog="asset-picker">
        <DialogHeader
          title={title}
          closeLabel={t("Close")}
          description={mode === "choose-first-frame"
            ? t("Keep one image as the starting frame. The other project images will not be deleted.")
            : t("Reuse images already saved in this media project.")}
        />
        {failure ? <InlineFeedback className="media-project-asset-picker-feedback" role="alert" tone="danger" title={t(failure.productMessageKey)}>{failure.technicalMessage}</InlineFeedback> : null}
        {mode === "library" ? (
          <Tabs value={tab} onValueChange={(value) => setTab(value as "project" | "generated")}>
            <TabsList className="media-project-asset-picker-tabs" aria-label={t("Image sources")}>
              <TabsTrigger value="project">{t("Project images")}</TabsTrigger>
              <TabsTrigger value="generated">{t("Generated images")}</TabsTrigger>
            </TabsList>
            <DialogBody className="media-project-asset-picker-body">
              <TabsContent value="project">
                <ProjectAssetGrid
                  assets={visibleAssets}
                  cwd={cwd}
                  selectedIds={selectedIds}
                  maxSelection={maxSelection}
                  usageByAssetId={usageByAssetId}
                  deletingAssetId={deletingAssetId}
                  onSelect={select}
                  onDelete={(assetId) => void deleteAsset(assetId)}
                />
              </TabsContent>
              <TabsContent value="generated">
                <GeneratedArtifactGrid
                  artifacts={imageArtifacts}
                  cwd={cwd}
                  assets={assets}
                  selectedIds={selectedIds}
                  maxSelection={maxSelection}
                  importingArtifactId={importingArtifactId}
                  onImport={(artifact) => void importArtifact(artifact)}
                />
              </TabsContent>
            </DialogBody>
          </Tabs>
        ) : (
          <DialogBody className="media-project-asset-picker-body">
            <ProjectAssetGrid
              assets={visibleAssets}
              cwd={cwd}
              selectedIds={selectedIds}
              maxSelection={1}
              usageByAssetId={usageByAssetId}
              deletingAssetId=""
              onSelect={select}
            />
          </DialogBody>
        )}
        <DialogFooter>
          <span className="media-project-asset-picker-count">{t("Selected {count} of {max}", { count: selectedIds.size, max: maxSelection })}</span>
          <Button disabled={busy} onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" loading={confirming} disabled={busy || selectedIds.size === 0 || selectedIds.size > maxSelection} onClick={() => void confirm()}>{t("Use selected images")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProjectAssetGrid({
  assets,
  cwd,
  selectedIds,
  maxSelection,
  usageByAssetId,
  deletingAssetId,
  onSelect,
  onDelete,
}: {
  readonly assets: readonly MediaProjectAsset[];
  readonly cwd: string;
  readonly selectedIds: ReadonlySet<string>;
  readonly maxSelection: number;
  readonly usageByAssetId: ReadonlyMap<string, number>;
  readonly deletingAssetId: string;
  readonly onSelect: (assetId: string) => void;
  readonly onDelete?: (assetId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  if (assets.length === 0) return <EmptyImages label={t("No project images yet")} />;
  return <div className="media-project-asset-grid">{assets.map((asset) => {
    const selected = selectedIds.has(asset.id);
    const usageCount = usageByAssetId.get(asset.id) ?? 0;
    const selectionDisabled = maxSelection > 1 && !selected && selectedIds.size >= maxSelection;
    return <article className={`media-project-asset-card${selected ? " selected" : ""}`} key={asset.id}>
      <button type="button" className="media-project-asset-card-main" disabled={selectionDisabled} aria-pressed={selected} onClick={() => onSelect(asset.id)}>
        <img src={mediaProjectAssetContentUrl(cwd, asset.id)} alt="" />
        <span><strong>{asset.fileName}</strong><small>{asset.width} × {asset.height}{usageCount ? ` · ${t("Used by {count} scenes", { count: usageCount })}` : ""}</small></span>
      </button>
      {onDelete ? <IconButton className="media-project-asset-delete" icon={Trash2} label={t("Delete project image")} loading={deletingAssetId === asset.id} variant="danger" onClick={() => onDelete(asset.id)} /> : null}
    </article>;
  })}</div>;
}

function GeneratedArtifactGrid({
  artifacts,
  cwd,
  assets,
  selectedIds,
  maxSelection,
  importingArtifactId,
  onImport,
}: {
  readonly artifacts: readonly RunArtifact[];
  readonly cwd: string;
  readonly assets: readonly MediaProjectAsset[];
  readonly selectedIds: ReadonlySet<string>;
  readonly maxSelection: number;
  readonly importingArtifactId: string;
  readonly onImport: (artifact: RunArtifact) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  if (artifacts.length === 0) return <EmptyImages label={t("No generated images available")} />;
  return <div className="media-project-asset-grid">{artifacts.map((artifact) => {
    const imported = assets.find((asset) => asset.sourceArtifactId === artifact.id);
    const selected = Boolean(imported && selectedIds.has(imported.id));
    const disabled = maxSelection > 1 && !selected && selectedIds.size >= maxSelection;
    return <article className={`media-project-asset-card${selected ? " selected" : ""}`} key={artifact.id}>
      <img className="media-project-generated-image" src={artifactContentUrl(artifact.id, cwd)} alt="" />
      <span className="media-project-generated-copy"><strong>{artifact.title ?? t("Generated image")}</strong><small>{imported ? t("Saved to project") : t("Generation result")}</small></span>
      <Button leadingIcon={<Plus size={14} />} size="sm" variant={selected ? "secondary" : "ghost"} loading={importingArtifactId === artifact.id} disabled={disabled} onClick={() => onImport(artifact)}>{selected ? t("Selected") : imported ? t("Select") : t("Add to project")}</Button>
    </article>;
  })}</div>;
}

function EmptyImages({ label }: { readonly label: string }): React.JSX.Element {
  return <div className="media-project-asset-empty"><ImageIcon size={24} /><span>{label}</span></div>;
}
