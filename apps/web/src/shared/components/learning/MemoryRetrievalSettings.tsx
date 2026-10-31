import { useEffect, useState } from "react";
import { getMemorySemanticPolicy, listProviders, updateMemorySemanticPolicy } from "../../../api.js";
import type { MemorySemanticPolicyResponse, ProviderPreset } from "../../../types.js";
import { useI18n } from "../../../i18n.js";
import { Button, Checkbox, Field, InlineFeedback, Input, Select } from "../../ui/index.js";

export function MemoryRetrievalSettings({cwd}: {readonly cwd: string}): React.JSX.Element {
  const {t} = useI18n();
  const [configuration, setConfiguration] = useState<MemorySemanticPolicyResponse>();
  const [providers, setProviders] = useState<readonly ProviderPreset[]>([]);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [dimensions, setDimensions] = useState("");
  const [distance, setDistance] = useState("");
  const [remote, setRemote] = useState(false);
  const [privateRemote, setPrivateRemote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([getMemorySemanticPolicy(cwd), listProviders(cwd)]).then(([result, available]) => {
      if (!active) return;
      setConfiguration(result); setProviders(available.providers.filter(p => p.enabled && p.api === "openai-completions" && p.baseUrl));
      setProviderId(result.policy.providerPresetId ?? ""); setModel(result.policy.model ?? "");
      setDimensions(String(result.policy.dimensions ?? "")); setDistance(String(result.policy.maxDistance ?? ""));
      setRemote(result.policy.allowRemote === true); setPrivateRemote(result.policy.allowPrivateRemote === true);
    }).catch(caught => {if (active) setError(caught instanceof Error ? caught.message : String(caught));});
    return () => {active = false;};
  }, [cwd]);
  async function save(mode: "off" | "lancedb"): Promise<void> {
    if (!configuration || busy) return;
    setBusy(true); setError("");
    try {setConfiguration(await updateMemorySemanticPolicy(cwd, {expectedRevision: configuration.policy.revision, mode,
      providerPresetId: providerId, model, dimensions: Number(dimensions), maxDistance: Number(distance), allowRemote: remote,
      allowPrivateRemote: privateRemote, timeoutMs: 1000}));}
    catch (caught) {setError(caught instanceof Error ? caught.message : String(caught));}
    finally {setBusy(false);}
  }
  return <div className="learning-review-jobs">
    <p>{t("Optional semantic retrieval uses the selected embeddings service. Local text retrieval stays available.")}</p>
    {configuration ? <small>{t("Index status")}: {configuration.status.status}{configuration.status.reason ? ` · ${configuration.status.reason}` : ""}</small> : null}
    <Field label={t("Embedding provider")}><Select value={providerId} disabled={busy} onChange={e => setProviderId(e.target.value)}>
      <option value="">{t("Select a provider")}</option>{providers.map(p => <option value={p.id} key={p.id}>{p.displayName}</option>)}
    </Select></Field>
    <Field label={t("Embedding model")}><Input value={model} disabled={busy} onChange={e => setModel(e.target.value)} /></Field>
    <Field label={t("Vector dimensions")}><Input type="number" min={1} max={8192} value={dimensions} disabled={busy} onChange={e => setDimensions(e.target.value)} /></Field>
    <Field label={t("Maximum cosine distance")}><Input type="number" min={0} max={2} step="any" value={distance} disabled={busy} onChange={e => setDistance(e.target.value)} /></Field>
    <small>{t("Calibrate distance with labeled questions for this model. No universal threshold is supplied.")}</small>
    <Checkbox checked={remote} disabled={busy} onChange={e => {setRemote(e.target.checked); if (!e.target.checked) setPrivateRemote(false);}} label={t("Allow sending approved memory and queries to a remote embedding service")} />
    <Checkbox checked={privateRemote} disabled={busy || !remote} onChange={e => setPrivateRemote(e.target.checked)} label={t("Also allow private memory and private chat queries remotely")} />
    <div className="learning-review-toolbar">
      <Button size="sm" disabled={busy || !configuration || !providerId || !model.trim() || !dimensions || !distance} onClick={() => void save("lancedb")}>{t("Save semantic retrieval settings")}</Button>
      <Button size="sm" variant="ghost" disabled={busy || !configuration || configuration.policy.mode === "off"} onClick={() => void save("off")}>{t("Disable semantic retrieval")}</Button>
    </div>
    {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
  </div>;
}
