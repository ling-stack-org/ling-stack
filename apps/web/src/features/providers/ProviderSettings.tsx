import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  History,
  Loader2,
  Pencil,
  Play,
  PlugZap,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import {
  canBatchCheckProvider,
  canUseProviderForRun,
  customOpenAICompatibleForm,
  envNameFromRef,
  groupProviderTemplates,
  providerCheckGuidance,
  providerCheckStatusLabel,
  providerCodingTaskLabel,
  providerFormToTemplate,
  providerLastCheckClass,
  providerLastCheckLabel,
  providerLastCheckTitle,
  providerNeedsSecret,
  providerPreflightReady,
  providerRunBlockerLabel,
  providerRunPreflightBlocker,
  providerTemplateKindLabel,
  secretRefMissingLabel,
  secretRefName,
} from "../../lib/providers.js";
import { readRunProviderPresetId } from "../../lib/run-evidence.js";
import { MetaRow } from "../../shared/components/index.js";
import type {
  ProviderCheckResult,
  ProviderFormState,
  ProviderPreset,
  ProviderTemplate,
  RunSession,
} from "../../types.js";
import { buildProviderRepairItems, type ProviderRepairItem } from "./provider-repair.js";
import type { ProviderBatchResult } from "./types.js";

export function ProviderSettings({
  cwd,
  providers,
  templates,
  form,
  editingProviderId,
  isLoading,
  checkingProviderIds,
  errorMessage,
  checkResult,
  checkedProviderId,
  batchResult,
  selectedProviderId,
  repairRun,
  isRunning,
  onCwdChange,
  onFormChange,
  onTemplateSelect,
  onNew,
  onSave,
  onRefresh,
  onEdit,
  onDelete,
  onCheck,
  onCheckBatch,
  onUse,
  onRerun,
  onOpenRun,
  onClearRepair,
}: {
  readonly cwd: string;
  readonly providers: readonly ProviderPreset[];
  readonly templates: readonly ProviderTemplate[];
  readonly form: ProviderFormState;
  readonly editingProviderId: string;
  readonly isLoading: boolean;
  readonly checkingProviderIds: readonly string[];
  readonly errorMessage: string;
  readonly checkResult: ProviderCheckResult | undefined;
  readonly checkedProviderId: string;
  readonly batchResult: ProviderBatchResult | undefined;
  readonly selectedProviderId: string;
  readonly repairRun: RunSession | undefined;
  readonly isRunning: boolean;
  readonly onCwdChange: (cwd: string) => void;
  readonly onFormChange: (form: ProviderFormState) => void;
  readonly onTemplateSelect: (template: ProviderTemplate) => void;
  readonly onNew: () => void;
  readonly onSave: () => void;
  readonly onRefresh: () => void;
  readonly onEdit: (provider: ProviderPreset) => void;
  readonly onDelete: (providerId: string) => void;
  readonly onCheck: (providerId: string) => void;
  readonly onCheckBatch: () => void;
  readonly onUse: (provider: ProviderPreset) => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onClearRepair: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const compatibleProviderCount = providers.filter(canUseProviderForRun).length;
  const preflightReadyProviderCount = providers.filter(providerPreflightReady).length;
  const batchCheckProviderCount = providers.filter(canBatchCheckProvider).length;
  const missingSecretCount = providers.filter((provider) => providerNeedsSecret(provider) && !provider.apiKeyConfigured).length;
  const chatTemplateCount = templates.filter((template) => template.capabilities.includes("chat")).length;
  const mediaTemplateCount = templates.length - chatTemplateCount;
  const templateGroups = groupProviderTemplates(templates);
  const repairItems = buildProviderRepairItems(providers);
  const nextActionProvider =
    providers.find(
      (provider) =>
        provider.enabled &&
        provider.api !== "media-job" &&
        provider.capabilities.includes("chat") &&
        providerNeedsSecret(provider) &&
        !provider.apiKeyConfigured,
    ) ??
    providers.find(canUseProviderForRun) ??
    providers.find((provider) => providerNeedsSecret(provider) && !provider.apiKeyConfigured);
  const checkedProvider = checkedProviderId ? providers.find((provider) => provider.id === checkedProviderId) : undefined;
  const isCheckingProviders = checkingProviderIds.length > 0;
  const repairProviderId = repairRun ? readRunProviderPresetId(repairRun) : "";
  const repairProvider = repairProviderId ? providers.find((provider) => provider.id === repairProviderId) : undefined;

  return (
    <div className="provider-layout">
      <section className="panel provider-list-panel" aria-labelledby="provider-list-title">
        <div className="panel-title split">
          <span>
            <PlugZap size={18} />
            <h2 id="provider-list-title">{t("Model Workbench")}</h2>
          </span>
          <div className="provider-title-actions">
            <button className="secondary-button compact-button" type="button" onClick={onCheckBatch} disabled={isCheckingProviders || batchCheckProviderCount === 0}>
              {isCheckingProviders ? <Loader2 className="spin" size={15} /> : <CheckCircle2 size={15} />}
              {t("Check all")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={isLoading || isCheckingProviders}>
              {isLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
              {t("Refresh")}
            </button>
          </div>
        </div>

        <label className="field wide runs-cwd">
          <span>{t("Workspace path")}</span>
          <input value={cwd} onChange={(event) => onCwdChange(event.target.value)} />
        </label>

        {errorMessage ? (
          <div className="inline-error">
            <CircleAlert size={17} />
            {errorMessage}
          </div>
        ) : null}

        <div className="provider-onboarding-strip" aria-label="Provider onboarding status">
          <MetaRow label={t("Chat-capable")} value={String(compatibleProviderCount)} compact />
          <MetaRow label={t("Coding ready")} value={String(preflightReadyProviderCount)} compact />
          <MetaRow label={t("Missing secrets")} value={String(missingSecretCount)} compact />
          <MetaRow label={t("Templates")} value={`${chatTemplateCount} chat / ${mediaTemplateCount} media`} compact />
        </div>

        <ProviderNextAction providers={providers} nextActionProvider={nextActionProvider} isLoading={isLoading} />
        {repairRun ? (
          <ProviderRunRepairPanel
            run={repairRun}
            provider={repairProvider}
            isChecking={repairProvider ? checkingProviderIds.includes(repairProvider.id) : false}
            isRunning={isRunning}
            onEdit={onEdit}
            onCheck={onCheck}
            onRerun={onRerun}
            onOpenRun={onOpenRun}
            onClear={onClearRepair}
          />
        ) : null}
        {providers.length > 0 ? (
          <ProviderRepairQueue
            items={repairItems}
            checkingProviderIds={checkingProviderIds}
            onEdit={onEdit}
            onCheck={onCheck}
          />
        ) : null}
        {batchResult ? (
          <div className={batchResult.failedCount === 0 ? "provider-batch-result ok" : "provider-batch-result bad"}>
            {batchResult.failedCount === 0 ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
            <span>{batchResult.message}</span>
          </div>
        ) : null}

        <div className="provider-list">
          {providers.length === 0 ? (
            <div className="empty-state compact-empty">
              {isLoading ? <Loader2 className="spin" /> : <PlugZap />}
              <span>{isLoading ? t("Loading providers...") : t("Create a model preset from GPT, Claude, domestic, relay, or custom OpenAI-compatible entries")}</span>
            </div>
          ) : (
            providers.map((provider) => (
              <article key={provider.id} className={provider.id === selectedProviderId ? "provider-row selected" : "provider-row"}>
                <div className="provider-row-main">
                  <div className="provider-row-head">
                    <strong>{provider.displayName}</strong>
                    <span className={provider.enabled ? "provider-state enabled" : "provider-state disabled"}>
                      {provider.enabled ? t("enabled") : t("disabled")}
                    </span>
                    <span className={provider.apiKeyConfigured ? "provider-state key-ok" : "provider-state key-missing"}>
                      {provider.apiKeyRef ? (provider.apiKeyConfigured ? t("key ready") : t("key missing")) : t("no key ref")}
                    </span>
                    <span className={providerPreflightReady(provider) ? "provider-state run-ready" : "provider-state run-blocked"}>
                      {providerPreflightReady(provider) ? t("preflight ready") : canUseProviderForRun(provider) ? t("needs check") : providerRunBlockerLabel(provider)}
                    </span>
                    <span className={providerPreflightReady(provider) ? "provider-state run-ready" : "provider-state run-blocked"}>
                      {t("Coding task")}: {providerCodingTaskLabel(provider)}
                    </span>
                    <span className={providerLastCheckClass(provider)} title={providerLastCheckTitle(provider)}>
                      {providerLastCheckLabel(provider)}
                    </span>
                  </div>
                  <div className="provider-meta-line">
                    <span>{provider.kind}</span>
                    <span>{provider.providerId}</span>
                    <span>{provider.model}</span>
                    <span>{provider.api}</span>
                    <span>{provider.lastCheck ? t("last check {time}", { time: formatDateTime(provider.lastCheck.checkedAt) }) : t("not checked")}</span>
                  </div>
                  <div className="provider-meta-line mono">
                    <span>{provider.baseUrl ?? "default endpoint"}</span>
                    {provider.apiKeyRef ? <span>{provider.apiKeyRef}</span> : null}
                  </div>
                  <div className="capability-list">
                    {provider.capabilities.map((capability) => (
                      <span key={capability}>{capability}</span>
                    ))}
                  </div>
                </div>
                <div className="provider-actions">
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    disabled={!providerPreflightReady(provider)}
                    onClick={() => onUse(provider)}
                  >
                    <Play size={14} />
                    {t("Use")}
                  </button>
                  <button className="secondary-button compact-button" type="button" onClick={() => onEdit(provider)}>
                    <Pencil size={14} />
                    {t("Edit")}
                  </button>
                  <button className="secondary-button compact-button" type="button" disabled={isCheckingProviders} onClick={() => onCheck(provider.id)}>
                    {checkingProviderIds.includes(provider.id) ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
                    {t("Check")}
                  </button>
                  <button className="secondary-button compact-button danger" type="button" onClick={() => onDelete(provider.id)}>
                    <Trash2 size={14} />
                    {t("Delete")}
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </section>

      <section className="panel provider-form-panel" aria-labelledby="provider-form-title">
        <div className="panel-title split">
          <span>
            <Settings size={18} />
            <h2 id="provider-form-title">{editingProviderId ? t("Edit preset") : t("New preset")}</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={onNew}>
            <Plus size={14} />
            {t("New")}
          </button>
        </div>

        <div className="provider-template-board" aria-label={t("Model templates")}>
          <div className="provider-template-group custom-provider-group">
            <div className="provider-template-group-head">
              <span>{t("Custom access")}</span>
              <small>1</small>
            </div>
            <button
              className="provider-template-card custom-provider-card"
              type="button"
              onClick={() => onTemplateSelect(providerFormToTemplate(customOpenAICompatibleForm))}
            >
              <span className="provider-template-kind">{t("Custom")}</span>
              <strong>{t("Custom OpenAI-compatible")}</strong>
              <span className="provider-template-model">baseUrl + model + secret ref</span>
              <small>{t("Use this for domestic gateways, private relays, One API, New API, LiteLLM, or any OpenAI-compatible endpoint.")}</small>
              <code>env:CUSTOM_MODEL_API_KEY</code>
            </button>
          </div>
          {templateGroups.length === 0 ? (
            <div className="empty-state compact-empty">
              <PlugZap />
              <span>{t("No templates available.")}</span>
            </div>
          ) : (
            templateGroups.map((group) => (
              <div key={group.label} className="provider-template-group">
                <div className="provider-template-group-head">
                  <span>{t(group.label)}</span>
                  <small>{group.templates.length}</small>
                </div>
                <div className="provider-template-grid">
                  {group.templates.map((template) => (
                    <button
                      key={template.templateId}
                      className="provider-template-card"
                      type="button"
                      onClick={() => onTemplateSelect(template)}
                    >
                      <span className="provider-template-kind">{t(providerTemplateKindLabel(template))}</span>
                      <strong>{template.displayName}</strong>
                      <span className="provider-template-model">{template.model}</span>
                      <small>{template.description}</small>
                      {template.apiKeyRef ? <code>{template.apiKeyRef}</code> : null}
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="field-row">
          <label className="field">
            <span>{t("Kind")}</span>
            <select value={form.kind} onChange={(event) => onFormChange({ ...form, kind: event.target.value as ProviderFormState["kind"] })}>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="openai-compatible">OpenAI compatible</option>
              <option value="doubao">Doubao</option>
              <option value="deepseek">DeepSeek</option>
              <option value="minimax">MiniMax</option>
              <option value="glm">GLM</option>
              <option value="jimeng">Jimeng</option>
              <option value="seedream">Seedream</option>
              <option value="seedance">Seedance</option>
            </select>
          </label>
          <label className="field">
            <span>{t("Display name")}</span>
            <input value={form.displayName} onChange={(event) => onFormChange({ ...form, displayName: event.target.value })} />
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span>{t("Provider id")}</span>
            <input value={form.providerId} onChange={(event) => onFormChange({ ...form, providerId: event.target.value })} />
          </label>
          <label className="field">
            <span>{t("Model")}</span>
            <input value={form.model} onChange={(event) => onFormChange({ ...form, model: event.target.value })} />
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span>{t("API protocol")}</span>
            <select value={form.api} onChange={(event) => onFormChange({ ...form, api: event.target.value as ProviderFormState["api"] })}>
              <option value="openai-completions">OpenAI completions</option>
              <option value="openai-responses">OpenAI responses</option>
              <option value="anthropic-messages">Anthropic messages</option>
              <option value="google-generative-ai">Google generative AI</option>
              <option value="mistral-conversations">Mistral conversations</option>
              <option value="media-job">Media job</option>
            </select>
          </label>
          <label className="field">
            <span>{t("Base URL")}</span>
            <input value={form.baseUrl} onChange={(event) => onFormChange({ ...form, baseUrl: event.target.value })} />
          </label>
        </div>

        <label className="field wide">
          <span>{t("API key ref")}</span>
          <input value={form.apiKeyRef} placeholder="env:LOCAL_RELAY_API_KEY or keychain:provider_local" onChange={(event) => onFormChange({ ...form, apiKeyRef: event.target.value })} />
        </label>
        <ProviderEnvHint apiKeyRef={form.apiKeyRef} />

        <div className="field-row provider-number-row">
          <label className="field">
            <span>{t("Input")}</span>
            <input value={form.inputText} onChange={(event) => onFormChange({ ...form, inputText: event.target.value })} />
          </label>
          <label className="field">
            <span>{t("Context")}</span>
            <input value={form.contextWindow} inputMode="numeric" onChange={(event) => onFormChange({ ...form, contextWindow: event.target.value })} />
          </label>
          <label className="field">
            <span>{t("Max tokens")}</span>
            <input value={form.maxTokens} inputMode="numeric" onChange={(event) => onFormChange({ ...form, maxTokens: event.target.value })} />
          </label>
        </div>

        <label className="field wide">
          <span>{t("Capabilities")}</span>
          <input value={form.capabilitiesText} onChange={(event) => onFormChange({ ...form, capabilitiesText: event.target.value })} />
        </label>

        <div className="provider-toggle-row">
          <label className="settings-toggle">
            <input type="checkbox" checked={form.enabled} onChange={(event) => onFormChange({ ...form, enabled: event.target.checked })} />
            <span>{t("Enabled")}</span>
          </label>
          <label className="settings-toggle">
            <input type="checkbox" checked={form.authHeader} onChange={(event) => onFormChange({ ...form, authHeader: event.target.checked })} />
            <span>{t("Auth header")}</span>
          </label>
          <label className="settings-toggle">
            <input type="checkbox" checked={form.reasoning} onChange={(event) => onFormChange({ ...form, reasoning: event.target.checked })} />
            <span>{t("Reasoning")}</span>
          </label>
        </div>

        {checkResult ? (
          <div className={checkResult.ok ? "check-result ok" : "check-result bad"}>
            {checkResult.ok ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
            <div className="check-result-copy">
              <span className="check-result-status">{providerCheckStatusLabel(checkResult)}</span>
              <strong>{checkedProvider ? checkedProvider.displayName : t("Provider check")}</strong>
              <span>{checkResult.message}</span>
              <small>{providerCheckGuidance(checkResult, checkedProvider ?? (editingProviderId ? providers.find((provider) => provider.id === editingProviderId) : undefined))}</small>
            </div>
          </div>
        ) : null}

        <div className="action-row">
          <button className="primary-button" type="button" onClick={onSave}>
            <Save size={16} />
            {editingProviderId ? t("Save changes") : t("Create preset")}
          </button>
          <button className="secondary-button" type="button" disabled={!editingProviderId || isCheckingProviders} onClick={() => onCheck(editingProviderId)}>
            {checkingProviderIds.includes(editingProviderId) ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />}
            {t("Check preset")}
          </button>
        </div>
        <div className="provider-form-hint">
          {editingProviderId ? t("Run Check after saving to validate secret ref, base URL, and model access.") : t("Create the preset first, then run Check before using it in Workspace.")}
        </div>
      </section>
    </div>
  );
}

function ProviderNextAction({
  providers,
  nextActionProvider,
  isLoading,
}: {
  readonly providers: readonly ProviderPreset[];
  readonly nextActionProvider: ProviderPreset | undefined;
  readonly isLoading: boolean;
}): JSX.Element | null {
  const { t } = useI18n();

  if (isLoading) {
    return null;
  }

  if (providers.length === 0) {
    return (
      <div className="provider-next-action">
        <CircleAlert size={16} />
        <span>{t("Next: choose a template, save the preset, then run Check before using it.")}</span>
      </div>
    );
  }

  const readyProvider = providers.find(providerPreflightReady);
  if (readyProvider) {
    return (
      <div className="provider-next-action ok">
        <CheckCircle2 size={16} />
        <span>
          {t("Ready: {providerName} passed preflight and can run tasks. Re-check after secret, base URL, or model changes.", { providerName: readyProvider.displayName })}
        </span>
      </div>
    );
  }

  if (nextActionProvider && providerNeedsSecret(nextActionProvider) && !nextActionProvider.apiKeyConfigured) {
    const envName = nextActionProvider.apiKeyRef ? secretRefMissingLabel(nextActionProvider.apiKeyRef) : "secret ref";
    return (
      <div className="provider-next-action">
        <CircleAlert size={16} />
        <span>
          {t("Next: set {envName} for {providerName}, restart the daemon, then run Check.", { envName, providerName: nextActionProvider.displayName })}
        </span>
      </div>
    );
  }

  if (nextActionProvider && canUseProviderForRun(nextActionProvider)) {
    if (!nextActionProvider.lastCheck) {
      return (
        <div className="provider-next-action">
          <CircleAlert size={16} />
          <span>{t("Next: run Check for {providerName} before using it in Workspace.", { providerName: nextActionProvider.displayName })}</span>
        </div>
      );
    }
    if (!nextActionProvider.lastCheck.ok) {
      return (
        <div className="provider-next-action">
          <CircleAlert size={16} />
          <span>
            Next: repair {nextActionProvider.displayName} check failure ({providerCheckStatusLabel(nextActionProvider.lastCheck)}), then run Check again.
          </span>
        </div>
      );
    }
  }

  return (
    <div className="provider-next-action">
      <CircleAlert size={16} />
      <span>{t("Next: enable a chat provider with a supported API protocol, then run Check.")}</span>
    </div>
  );
}

function ProviderRunRepairPanel({
  run,
  provider,
  isChecking,
  isRunning,
  onEdit,
  onCheck,
  onRerun,
  onOpenRun,
  onClear,
}: {
  readonly run: RunSession;
  readonly provider: ProviderPreset | undefined;
  readonly isChecking: boolean;
  readonly isRunning: boolean;
  readonly onEdit: (provider: ProviderPreset) => void;
  readonly onCheck: (providerId: string) => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onClear: () => void;
}): JSX.Element {
  const providerReady = provider ? providerPreflightReady(provider) : false;
  const providerCheckText = provider
    ? provider.lastCheck
      ? `${providerCheckStatusLabel(provider.lastCheck)}: ${provider.lastCheck.message}`
      : "Provider has not been checked yet."
    : "The provider preset used by this run is missing.";

  return (
    <div className="provider-run-repair" aria-label="Provider run repair">
      <div className="provider-run-repair-head">
        <span>
          <CircleAlert size={16} />
          <strong>Repair failed run provider</strong>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="provider-run-repair-copy">
        <span>
          Run <code>{run.id}</code> failed with <strong>{provider?.displayName ?? (readRunProviderPresetId(run) || "missing provider")}</strong>.
        </span>
        {run.errorMessage ? <small>{run.errorMessage}</small> : null}
        <small>{providerCheckText}</small>
      </div>
      <div className="provider-run-repair-steps">
        <span className={provider ? "provider-state check-ok" : "provider-state check-bad"}>{provider ? "provider found" : "provider missing"}</span>
        <span className={providerReady ? "provider-state run-ready" : "provider-state run-blocked"}>
          {providerReady ? "preflight ready" : provider ? providerRunPreflightBlocker(provider) : "cannot rerun"}
        </span>
      </div>
      <div className="provider-run-repair-actions">
        <button className="secondary-button compact-button" type="button" onClick={() => provider && onEdit(provider)} disabled={!provider}>
          <Pencil size={14} />
          Edit provider
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => provider && onCheck(provider.id)} disabled={!provider || isChecking || isRunning}>
          {isChecking ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
          Check provider
        </button>
        <button className="primary-button compact-button" type="button" onClick={() => onRerun(run)} disabled={!providerReady || isChecking || isRunning}>
          {isRunning ? <Loader2 className="spin" size={14} /> : <RotateCcw size={14} />}
          Rerun
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(run.id)}>
          <History size={14} />
          Back to run
        </button>
      </div>
    </div>
  );
}

function ProviderRepairQueue({
  items,
  checkingProviderIds,
  onEdit,
  onCheck,
}: {
  readonly items: readonly ProviderRepairItem[];
  readonly checkingProviderIds: readonly string[];
  readonly onEdit: (provider: ProviderPreset) => void;
  readonly onCheck: (providerId: string) => void;
}): JSX.Element | null {
  if (items.length === 0) {
    return (
      <div className="provider-repair-queue ok">
        <CheckCircle2 size={16} />
        <span>All saved chat providers are either preflight-ready or intentionally out of the run path.</span>
      </div>
    );
  }

  return (
    <div className="provider-repair-queue" aria-label="Provider repair queue">
      <div className="provider-repair-head">
        <span>Repair queue</span>
        <small>{items.length}</small>
      </div>
      {items.map((item) => (
        <article key={item.provider.id} className={`provider-repair-item ${item.status}`}>
          {item.status === "warning" ? <Clock3 size={16} /> : <CircleAlert size={16} />}
          <span className="provider-repair-copy">
            <strong>{item.title}</strong>
            <small>{item.detail}</small>
          </span>
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={() => {
              if (item.action === "check") {
                onCheck(item.provider.id);
                return;
              }
              onEdit(item.provider);
            }}
            disabled={checkingProviderIds.includes(item.provider.id)}
          >
            {checkingProviderIds.includes(item.provider.id) ? (
              <Loader2 className="spin" size={14} />
            ) : item.action === "check" ? (
              <CheckCircle2 size={14} />
            ) : (
              <Pencil size={14} />
            )}
            {item.actionLabel}
          </button>
        </article>
      ))}
    </div>
  );
}

function ProviderEnvHint({ apiKeyRef }: { readonly apiKeyRef: string }): JSX.Element {
  const trimmedRef = apiKeyRef.trim();
  if (!trimmedRef) {
    return (
      <div className="provider-env-hint">
        <SquareTerminal size={15} />
        <span>Use a secret ref like <code>env:DEEPSEEK_API_KEY</code> or <code>keychain:provider_deepseek</code>.</span>
      </div>
    );
  }

  if (trimmedRef.startsWith("keychain:")) {
    return (
      <div className="provider-env-hint">
        <SquareTerminal size={15} />
        <span>
          Keychain ref: <code>{secretRefName(trimmedRef)}</code>. The daemon reports status only; desktop owns secret storage.
        </span>
      </div>
    );
  }

  if (!trimmedRef.startsWith("env:")) {
    return (
      <div className="provider-env-hint">
        <SquareTerminal size={15} />
        <span>Use <code>env:NAME</code> or <code>keychain:NAME</code>; raw secret values are not stored here.</span>
      </div>
    );
  }

  const envName = envNameFromRef(trimmedRef);
  return (
    <div className="provider-env-hint">
      <SquareTerminal size={15} />
      <span>
        Shell: <code>export {envName}=...</code>. Restart or reload the daemon after setting env.
      </span>
    </div>
  );
}
