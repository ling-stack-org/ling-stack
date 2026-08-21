import { ImageIcon, Images, RefreshCw, Upload, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  IconButton,
  InlineFeedback,
  SegmentedControl,
  SegmentedControlItem,
} from "../../shared/ui/index.js";
import type {
  MediaProjectAsset,
  MediaScene,
  MediaSceneVideoImageInput,
  MediaSceneVideoImageRole,
  RunArtifact,
  VideoGenerationCapabilities,
} from "../../types.js";
import { mediaProjectAssetContentUrl } from "../../api/media-production.js";
import { MediaProjectAssetPickerDialog } from "./MediaProjectAssetPickerDialog.js";
import {
  MediaProjectImageFileError,
  mediaProjectImageUploadRequest,
  type MediaProjectImageFileIssue,
} from "./media-production-image-files.js";
import type { MediaProductionActions } from "./media-production-types.js";
import { deriveVideoImageInputIssue } from "./media-production-view-models.js";
import type {
  MediaProjectImageUploadState,
  MediaProjectPendingImageUpload,
} from "./use-media-project-image-uploads.js";

export function SceneVideoImageInputs({
  cwd,
  scene,
  projectAssets,
  projectScenes,
  imageArtifacts,
  capability,
  disabled,
  actions,
  imageUploadState,
  onChange,
}: {
  readonly cwd: string;
  readonly scene: MediaScene;
  readonly projectAssets: readonly MediaProjectAsset[];
  readonly projectScenes: readonly MediaScene[];
  readonly imageArtifacts: readonly RunArtifact[];
  readonly capability: VideoGenerationCapabilities | undefined;
  readonly disabled: boolean;
  readonly actions: MediaProductionActions;
  readonly imageUploadState: MediaProjectImageUploadState;
  readonly onChange: (inputs: readonly MediaSceneVideoImageInput[]) => Promise<boolean>;
}): React.JSX.Element {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pickerMode, setPickerMode] = useState<"library" | "choose-first-frame" | undefined>();
  const [localMessageKey, setLocalMessageKey] = useState<string>();
  const pendingUploads = imageUploadState.uploads.filter((upload) => upload.sceneId === scene.id);
  const uploading = pendingUploads.some((upload) => upload.state === "uploading");
  const inputs = scene.videoImageInputs;
  const inputRoles = new Set(inputs.map((item) => item.role));
  const currentRole = inputRoles.size === 1 ? inputs[0]?.role : undefined;
  const supportedRoles = capability?.inputModes.filter(isImageRole) ?? [];
  const activeRole = currentRole ?? preferredRole(supportedRoles);
  const maxSelection = maxImagesForRole(activeRole, capability);
  const remainingSlots = Math.max(0, maxSelection - inputs.length - pendingUploads.filter((item) => item.state === "uploading").length);
  const imageIssue = deriveVideoImageInputIssue(scene, projectAssets, capability);
  const selectedAssets = useMemo(() => inputs.map((input) => projectAssets.find((asset) => asset.id === input.assetId)).filter((asset): asset is MediaProjectAsset => Boolean(asset)), [inputs, projectAssets]);
  const showRoleControl = inputs.length > 0
    && supportedRoles.length > 0
    && (supportedRoles.length > 1 || Boolean(currentRole && !supportedRoles.includes(currentRole)));
  const canAdd = Boolean(activeRole && supportedRoles.includes(activeRole) && remainingSlots > 0 && !disabled && !uploading);

  const removePending = (pendingId: string): void => {
    imageUploadState.remove(pendingId);
  };

  const uploadFiles = async (files: readonly File[]): Promise<void> => {
    if (!activeRole || !supportedRoles.includes(activeRole) || uploading) return;
    const accepted = files.slice(0, remainingSlots);
    if (accepted.length < files.length) setLocalMessageKey("Some images were not added because this model's limit was reached.");
    else setLocalMessageKey(undefined);
    if (accepted.length === 0) return;
    const pending = imageUploadState.add(scene.projectId, scene.id, accepted);
    if (pending.length === 0) return;
    const addedAssetIds: string[] = [];
    const uploadedPendingIds: string[] = [];
    for (const item of pending) {
      const outcome = await uploadOne(item.file);
      if (outcome.ok) {
        addedAssetIds.push(outcome.assetId);
        uploadedPendingIds.push(item.id);
      } else {
        imageUploadState.update(item.id, {
          state: "failed",
          messageKey: outcome.messageKey,
          technicalMessage: outcome.technicalMessage,
        });
      }
    }
    if (addedAssetIds.length > 0) {
      const assetIds = unique([...inputs.map((item) => item.assetId), ...addedAssetIds]).slice(0, maxSelection);
      const attached = await onChange(assetIds.map((assetId) => ({ assetId, role: activeRole })));
      if (attached) {
        for (const pendingId of uploadedPendingIds) removePending(pendingId);
      } else {
        for (const pendingId of uploadedPendingIds) {
          imageUploadState.update(pendingId, { state: "failed", messageKey: "Could not attach this image to the scene." });
        }
      }
    }
  };

  const retryUpload = async (pending: MediaProjectPendingImageUpload): Promise<void> => {
    if (!activeRole || !supportedRoles.includes(activeRole) || uploading || remainingSlots <= 0) return;
    imageUploadState.update(pending.id, { state: "uploading", messageKey: undefined, technicalMessage: undefined });
    const outcome = await uploadOne(pending.file);
    if (outcome.ok) {
      const attached = await onChange(unique([...inputs.map((item) => item.assetId), outcome.assetId]).slice(0, maxSelection).map((assetId) => ({ assetId, role: activeRole })));
      if (attached) removePending(pending.id);
      else imageUploadState.update(pending.id, { state: "failed", messageKey: "Could not attach this image to the scene." });
    } else {
      imageUploadState.update(pending.id, { state: "failed", messageKey: outcome.messageKey, technicalMessage: outcome.technicalMessage });
    }
  };

  const uploadOne = async (file: File): Promise<{ readonly ok: true; readonly assetId: string } | { readonly ok: false; readonly messageKey: string; readonly technicalMessage?: string }> => {
    try {
      const request = await mediaProjectImageUploadRequest(file);
      const outcome = await actions.createProjectAsset(scene.projectId, request);
      if (!outcome.ok) return { ok: false, messageKey: outcome.failure.productMessageKey, technicalMessage: outcome.failure.technicalMessage };
      return { ok: true, assetId: outcome.value.id };
    } catch (error) {
      if (error instanceof MediaProjectImageFileError) return { ok: false, messageKey: imageFileIssueMessage(error.issue) };
      return { ok: false, messageKey: "Could not read this image.", technicalMessage: error instanceof Error ? error.message : String(error) };
    }
  };

  const changeRole = async (nextRole: MediaSceneVideoImageRole): Promise<void> => {
    if (nextRole === currentRole || !supportedRoles.includes(nextRole)) return;
    setLocalMessageKey(undefined);
    if (nextRole === "first_frame" && inputs.length > 1) {
      setPickerMode("choose-first-frame");
      return;
    }
    await onChange(inputs.map((item) => ({ ...item, role: nextRole })));
  };

  return (
    <div className="scene-video-image-inputs">
      <div className="scene-video-image-inputs-head">
        <span className="field-label">{t("Image inputs")}</span>
        <span className="scene-video-image-input-actions">
          <input
            ref={fileInputRef}
            className="scene-video-image-file-input"
            type="file"
            data-ling-control-native="true"
            accept="image/jpeg,image/png,image/webp"
            multiple={activeRole === "reference_image" && maxSelection > 1}
            tabIndex={-1}
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = "";
              void uploadFiles(files);
            }}
          />
          <Button leadingIcon={<Upload size={14} />} size="sm" variant="secondary" disabled={!canAdd} onClick={() => fileInputRef.current?.click()}>{t("Upload image")}</Button>
          <Button leadingIcon={<Images size={14} />} size="sm" variant="ghost" disabled={disabled || uploading || !activeRole || !supportedRoles.includes(activeRole) || maxSelection <= 0} onClick={() => setPickerMode("library")}>{t("Project images")}</Button>
        </span>
      </div>

      {selectedAssets.length > 0 || pendingUploads.length > 0 ? (
        <div className="scene-video-image-strip" aria-label={t("Selected images")}>
          {selectedAssets.map((asset) => <article className="scene-video-image-card" key={asset.id}>
            <img src={mediaProjectAssetContentUrl(cwd, asset.id)} alt="" />
            <span title={asset.fileName}>{asset.fileName}</span>
            <IconButton icon={X} label={t("Remove from scene")} disabled={disabled || uploading} onClick={() => void onChange(inputs.filter((item) => item.assetId !== asset.id))} />
          </article>)}
          {pendingUploads.map((pending) => <article className={`scene-video-image-card pending ${pending.state}`} key={pending.id}>
            <img src={pending.previewUrl} alt="" />
            <span title={pending.file.name}>{pending.file.name}</span>
            {pending.state === "failed" ? <span className="scene-video-image-pending-actions">
              <IconButton icon={RefreshCw} label={t("Retry upload")} disabled={disabled || uploading || remainingSlots <= 0} onClick={() => void retryUpload(pending)} />
              <IconButton icon={X} label={t("Remove failed upload")} disabled={uploading} onClick={() => removePending(pending.id)} />
            </span> : <small>{t("Uploading")}</small>}
          </article>)}
        </div>
      ) : null}

      {inputs.length > 0 ? (
        <div className="scene-video-image-role-row">
          <span>{t("Image purpose")}</span>
          {showRoleControl ? (
            <SegmentedControl size="sm" value={currentRole ?? ""} disabled={disabled || uploading} aria-label={t("Image purpose")} onValueChange={(value) => void changeRole(value as MediaSceneVideoImageRole)}>
              {roleControlValues(supportedRoles, currentRole).map((role) => <SegmentedControlItem key={role} value={role} disabled={!supportedRoles.includes(role)}>{t(role === "reference_image" ? "Reference images" : "Starting frame")}</SegmentedControlItem>)}
            </SegmentedControl>
          ) : <strong>{t(currentRole === "reference_image" ? "Reference images" : "Starting frame")}</strong>}
          <small>{maxSelection > 0
            ? t("Selected {count} of {max}", { count: inputs.length, max: maxSelection })
            : t("Selected {count}", { count: inputs.length })}</small>
        </div>
      ) : null}

      {imageIssue ? <InlineFeedback tone="warning" title={t(imageIssue.key, imageIssue.values)} /> : null}
      {localMessageKey ? <InlineFeedback tone="warning" title={t(localMessageKey)} /> : null}
      {pendingUploads.filter((item) => item.state === "failed").map((item) => <InlineFeedback key={`${item.id}:failure`} tone="danger" title={t(item.messageKey ?? "Could not add this project image.")}>{item.technicalMessage}</InlineFeedback>)}

      {pickerMode ? <MediaProjectAssetPickerDialog
        open
        mode={pickerMode}
        cwd={cwd}
        assets={projectAssets}
        scenes={projectScenes}
        imageArtifacts={imageArtifacts}
        initialSelectedIds={inputs.map((item) => item.assetId)}
        maxSelection={pickerMode === "choose-first-frame" ? 1 : maxSelection}
        actions={actions}
        projectId={scene.projectId}
        onClose={() => setPickerMode(undefined)}
        onConfirm={async (assetIds) => {
          const role = pickerMode === "choose-first-frame" ? "first_frame" : activeRole;
          if (!role) return;
          const saved = await onChange(assetIds.map((assetId) => ({ assetId, role })));
          if (saved) setPickerMode(undefined);
        }}
      /> : null}
    </div>
  );
}

function preferredRole(roles: readonly MediaSceneVideoImageRole[]): MediaSceneVideoImageRole | undefined {
  return roles.includes("reference_image") ? "reference_image" : roles[0];
}

function isImageRole(value: string): value is MediaSceneVideoImageRole {
  return value === "first_frame" || value === "reference_image";
}

function maxImagesForRole(role: MediaSceneVideoImageRole | undefined, capability: VideoGenerationCapabilities | undefined): number {
  if (role === "first_frame") return 1;
  if (role === "reference_image") return capability?.maxReferenceImages ?? 0;
  return 0;
}

function roleControlValues(
  supported: readonly MediaSceneVideoImageRole[],
  current: MediaSceneVideoImageRole | undefined,
): readonly MediaSceneVideoImageRole[] {
  return unique([...(current ? [current] : []), ...supported]);
}

function imageFileIssueMessage(issue: MediaProjectImageFileIssue): string {
  if (issue === "unsupported_type") return "Upload a JPEG, PNG, or WebP image.";
  if (issue === "empty_file") return "This image file is empty.";
  if (issue === "file_too_large") return "Each image must be 25 MiB or smaller.";
  return "Could not read this image.";
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
