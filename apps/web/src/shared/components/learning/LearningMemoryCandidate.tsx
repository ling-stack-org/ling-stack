import { useEffect, useState } from "react";
import { getMemoryObject, reviewMemory } from "../../../api.js";
import { useI18n } from "../../../i18n.js";
import type { MemoryObject } from "../../../types.js";
import { Button, InlineFeedback } from "../../ui/index.js";

/** Review stays at the result's original scope; approving never promotes ownership. */
export function LearningMemoryCandidate({cwd, candidateId}: {readonly cwd: string; readonly candidateId: string}): React.JSX.Element {
  const {t} = useI18n();
  const [memory, setMemory] = useState<MemoryObject>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [otherResult, setOtherResult] = useState(false);
  useEffect(() => {
    let active = true;
    void getMemoryObject(cwd, candidateId).then(result => {if (active) setMemory(result.memory);})
      .catch(caught => {if (active) {
        if (caught && typeof caught === "object" && "status" in caught && caught.status === 404) setOtherResult(true);
        else setError(caught instanceof Error ? caught.message : String(caught));
      }});
    return () => {active = false;};
  }, [cwd, candidateId]);
  async function review(action: "approve" | "archive"): Promise<void> {
    if (busy) return;
    setBusy(true); setError("");
    try {const result = await reviewMemory(cwd, candidateId, {action, actor: "local-user"}); setMemory(result.memory);}
    catch (caught) {setError(caught instanceof Error ? caught.message : String(caught));}
    finally {setBusy(false);}
  }
  if (otherResult) return <p>{t("Review this result in the channel review queue.")} <code>{candidateId}</code></p>;
  return <div data-learning-memory-id={candidateId}>
    {memory ? <>
      <strong>{memory.reviewState === "active" ? t("Memory approved") : memory.reviewState === "candidate" ? t("Memory awaiting review") : t("Memory archived")}: {memory.title}</strong>
      <pre>{memory.body}</pre>
      <small>{memory.scopeType} · {memory.ownerId}</small>
      <details><summary>{t("Sources")}</summary><ul>{memory.sourceRefs.map((source, i) => <li key={i}>{source.type} · {source.id}</li>)}</ul></details>
      <div className="learning-review-toolbar">
        {memory.reviewState === "candidate" ? <Button size="sm" disabled={busy} onClick={() => void review("approve")}>{t("Approve memory")}</Button> : null}
        {memory.reviewState === "active" || memory.reviewState === "candidate" ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void review("archive")}>{t("Archive memory")}</Button> : null}
      </div>
    </> : <small>{t("Loading…")}</small>}
    {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
  </div>;
}
