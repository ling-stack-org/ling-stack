import { useEffect, useMemo, useState } from "react";
import { getConversationMediaGenerationTargets } from "../../api/media.js";
import { useI18n } from "../../i18n.js";
import { providerModelRouteLabel, providerPreflightReady } from "../../lib/providers.js";
import { Select, StatusIndicator } from "../../shared/ui/index.js";
import type {
  ConversationMediaGenerationTargetsResponse,
  MediaGenerationKind,
  MediaGenerationTargetRef,
  MediaGenerationTargetView,
  ProviderPreset,
  UpdateWorkspaceSettingsRequest,
  WorkspaceMediaGenerationDefaults,
  WorkspaceSettings,
} from "../../types.js";

const noExplicitTarget = "__no_explicit_target__";

export function ProviderDefaultPurposeBar(props: {
  readonly cwd: string;
  readonly providers: readonly ProviderPreset[];
  readonly workspaceSettings?: WorkspaceSettings;
  readonly onPatchWorkspaceSettings: (
    patch: UpdateWorkspaceSettingsRequest,
  ) => Promise<WorkspaceSettings | undefined>;
}): React.JSX.Element {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<ConversationMediaGenerationTargetsResponse>();
  const [loading, setLoading] = useState(false);
  const [savingPurpose, setSavingPurpose] = useState<"chat" | MediaGenerationKind>();
  const [errorMessage, setErrorMessage] = useState("");
  const providerRevision = useMemo(
    () => props.providers.map((provider) => [
      provider.id,
      provider.enabled,
      provider.apiKeyConfigured,
      provider.lastCheck?.checkedAt ?? "",
      provider.capabilities.join(","),
    ].join(":" )).join("|"),
    [props.providers],
  );

  useEffect(() => {
    const cwd = props.cwd.trim();
    if (!cwd) {
      setSnapshot(undefined);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setErrorMessage("");
    void getConversationMediaGenerationTargets(cwd).then(
      (next) => {
        if (!cancelled) setSnapshot(next);
      },
      (error: unknown) => {
        if (!cancelled) setErrorMessage(error instanceof Error ? error.message : String(error));
      },
    ).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [props.cwd, providerRevision]);

  const defaults = props.workspaceSettings?.mediaGenerationDefaults ?? snapshot?.defaults ?? {};
  const chatProviders = props.providers.filter((provider) => providerPreflightReady(provider));
  const currentChatId = props.workspaceSettings?.defaultProviderPresetId ?? "";
  const unavailableCurrentChat = currentChatId && !chatProviders.some((provider) => provider.id === currentChatId)
    ? props.providers.find((provider) => provider.id === currentChatId)
    : undefined;

  async function saveChat(providerPresetId: string): Promise<void> {
    setSavingPurpose("chat");
    setErrorMessage("");
    try {
      await props.onPatchWorkspaceSettings({ defaultProviderPresetId: providerPresetId || null });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingPurpose(undefined);
    }
  }

  async function saveMedia(kind: MediaGenerationKind, value: string): Promise<void> {
    const target = snapshot?.targets.find((candidate) => candidate.generationKind === kind && candidate.id === value);
    const nextDefaults = replaceMediaDefault(defaults, kind, target?.ref);
    setSavingPurpose(kind);
    setErrorMessage("");
    try {
      const updated = await props.onPatchWorkspaceSettings({
        mediaGenerationDefaults: hasMediaDefault(nextDefaults) ? nextDefaults : null,
      });
      if (updated) {
        setSnapshot((current) => current ? {
          ...current,
          defaults: updated.mediaGenerationDefaults ?? {},
        } : current);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingPurpose(undefined);
    }
  }

  return (
    <section className="provider-default-purpose-bar" aria-label={t("Default uses")}>
      <label className="provider-default-purpose-field">
        <span>{t("Chat model")}</span>
        <Select
          size="sm"
          value={currentChatId}
          disabled={loading || savingPurpose !== undefined}
          onChange={(event) => void saveChat(event.target.value)}
        >
          <option value="">{t("Not configured")}</option>
          {unavailableCurrentChat ? (
            <option value={unavailableCurrentChat.id} disabled>
              {t("{target} · Needs attention", { target: providerPurposeLabel(unavailableCurrentChat) })}
            </option>
          ) : null}
          {chatProviders.map((provider) => (
            <option value={provider.id} key={provider.id}>{providerPurposeLabel(provider)}</option>
          ))}
        </Select>
      </label>
      <MediaPurposeSelect
        kind="image"
        label={t("Image generation target")}
        targets={snapshot?.targets ?? []}
        providers={props.providers}
        defaultRef={defaults.image}
        disabled={loading || savingPurpose !== undefined}
        onChange={(value) => void saveMedia("image", value)}
      />
      <MediaPurposeSelect
        kind="video"
        label={t("Video generation target")}
        targets={snapshot?.targets ?? []}
        providers={props.providers}
        defaultRef={defaults.video}
        disabled={loading || savingPurpose !== undefined}
        onChange={(value) => void saveMedia("video", value)}
      />
      {savingPurpose ? <StatusIndicator label={t("Saving")} tone="info" /> : null}
      {errorMessage ? <span className="provider-default-purpose-error" role="alert">{errorMessage}</span> : null}
    </section>
  );
}

function MediaPurposeSelect(props: {
  readonly kind: MediaGenerationKind;
  readonly label: string;
  readonly targets: readonly MediaGenerationTargetView[];
  readonly providers: readonly ProviderPreset[];
  readonly defaultRef?: MediaGenerationTargetRef;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const targets = props.targets.filter((target) => target.generationKind === props.kind);
  const runnableTargets = targets.filter((target) => target.runnable);
  const selectedTarget = props.defaultRef
    ? targets.find((target) => mediaTargetRefKey(target.ref) === mediaTargetRefKey(props.defaultRef!))
    : undefined;
  const missingDefaultValue = props.defaultRef && !selectedTarget
    ? `__missing_${props.kind}_target__`
    : undefined;
  const selectedValue = selectedTarget?.id ?? missingDefaultValue ?? noExplicitTarget;
  const automaticLabel = runnableTargets.length === 1
    ? t("Automatic selection ({target})", { target: targetOptionLabel(runnableTargets[0], props.providers, t) })
    : runnableTargets.length > 1
      ? t("Ask when used ({count} available)", { count: runnableTargets.length })
      : t("Not configured");

  return (
    <label className="provider-default-purpose-field">
      <span>{props.label}</span>
      <Select
        size="sm"
        value={selectedValue}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      >
        <option value={noExplicitTarget}>{automaticLabel}</option>
        {missingDefaultValue ? (
          <option value={missingDefaultValue} disabled>{t("Unavailable target · Needs attention")}</option>
        ) : null}
        {targets.map((target) => (
          <option value={target.id} key={target.id} disabled={!target.runnable}>
            {target.runnable
              ? targetOptionLabel(target, props.providers, t)
              : t("{target} · Needs attention", { target: targetOptionLabel(target, props.providers, t) })}
          </option>
        ))}
      </Select>
    </label>
  );
}

function targetOptionLabel(
  target: MediaGenerationTargetView,
  providers: readonly ProviderPreset[],
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (target.ref.kind === "workflow") {
    return t("ComfyUI · {target}", { target: target.displayName });
  }
  const providerPresetId = target.ref.providerPresetId;
  const provider = providers.find((candidate) => candidate.id === providerPresetId);
  return t("Model · {target}", {
    target: provider ? providerPurposeLabel(provider) : target.displayName,
  });
}

function providerPurposeLabel(provider: ProviderPreset): string {
  return providerModelRouteLabel(provider);
}

function mediaTargetRefKey(ref: MediaGenerationTargetRef): string {
  return ref.kind === "provider"
    ? `provider:${ref.providerPresetId}`
    : `workflow:${ref.workflowDefinitionId}`;
}

function replaceMediaDefault(
  current: WorkspaceMediaGenerationDefaults,
  kind: MediaGenerationKind,
  ref: MediaGenerationTargetRef | undefined,
): WorkspaceMediaGenerationDefaults {
  const next = { ...current };
  if (ref) next[kind] = ref;
  else delete next[kind];
  return next;
}

function hasMediaDefault(value: WorkspaceMediaGenerationDefaults): boolean {
  return Boolean(value.image || value.video);
}
