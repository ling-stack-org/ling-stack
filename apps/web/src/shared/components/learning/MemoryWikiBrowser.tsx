import { useEffect, useRef, useState } from "react";
import { compileMemoryWiki, exportMemoryWiki, getMemoryWiki, listAiTeammates, listChannels, updateMemoryWikiHumanBlock } from "../../../api.js";
import type { MemoryWikiResponse, MemoryWikiScope } from "../../../types.js";
import { useI18n } from "../../../i18n.js";
import { Button, Field, InlineFeedback, Input, Select, Textarea } from "../../ui/index.js";

export function MemoryWikiDisclosure({cwd, runId}: {readonly cwd: string; readonly runId?: string}): React.JSX.Element {
  const {t} = useI18n();
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>{t("Knowledge Wiki")}</summary>
    {open ? <MemoryWikiBrowser key={cwd} cwd={cwd} runId={runId} /> : null}
  </details>;
}
function MemoryWikiBrowser({cwd, runId}: {readonly cwd: string; readonly runId?: string}): React.JSX.Element {
  const {t} = useI18n();
  const initial: MemoryWikiScope = runId ? {scopeType: "run", ownerId: runId} : {scopeType: "workspace", ownerId: "workspace_default"};
  const [scopes, setScopes] = useState<readonly {scope: MemoryWikiScope; label: string}[]>([{scope: initial, label: runId ? t("Run") : t("Workspace")}]);
  const [selected, setSelected] = useState(JSON.stringify(initial));
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([listChannels(cwd), listAiTeammates(cwd)]).then(([channels, teammates]) => {
      if (!active) return;
      setScopes([{scope: {scopeType: "workspace", ownerId: "workspace_default"}, label: t("Workspace")},
        ...(runId ? [{scope: {scopeType: "run" as const, ownerId: runId}, label: t("Run")}] : []),
        ...channels.channels.filter(c => c.status === "active").map(c => ({scope: {scopeType: "channel" as const, ownerId: c.id}, label: `${t("Channel")} · ${c.name}`})),
        ...teammates.teammates.filter(a => a.status === "active").map(a => ({scope: {scopeType: "teammate" as const, ownerId: a.id}, label: `${t("Teammate")} · ${a.displayName}`}))]);
    }).catch(caught => {if (active) setError(caught instanceof Error ? caught.message : String(caught));});
    return () => {active = false;};
  }, [cwd, runId, t]);
  return <div className="learning-review-jobs">
    <p>{t("Wiki shows approved sources in one scope. Rebuild after changes; it is never added to prompts automatically.")}</p>
    <Field label={t("Knowledge scope")}><Select value={selected} onChange={e => setSelected(e.target.value)}>
      {scopes.map(({scope, label}) => <option key={JSON.stringify(scope)} value={JSON.stringify(scope)}>{label}</option>)}
    </Select></Field>
    {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
    <MemoryWikiPartition key={`${cwd}:${selected}`} cwd={cwd} scope={JSON.parse(selected) as MemoryWikiScope} />
  </div>;
}
function MemoryWikiPartition({cwd, scope}: {readonly cwd: string; readonly scope: MemoryWikiScope}): React.JSX.Element {
  const {t} = useI18n();
  const [wiki, setWiki] = useState<MemoryWikiResponse>();
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState("");
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    void getMemoryWiki(cwd, scope).then(result => {if (alive.current) {setWiki(result); setNotes(result.human.text);}})
      .catch(caught => {if (alive.current) setError(caught instanceof Error ? caught.message : String(caught));});
    return () => {alive.current = false;};
  }, [cwd, scope]);
  async function act(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true); setError("");
    try {await action();} catch (caught) {if (alive.current) setError(caught instanceof Error ? caught.message : String(caught));}
    finally {if (alive.current) setBusy(false);}
  }
  const pageIds = topic ? wiki?.topics.find(entry => entry.key === topic)?.pageIds : undefined;
  const pages = wiki?.pages.filter(page => (!pageIds || pageIds.includes(page.id)) && `${page.title}\n${page.body}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="learning-review-jobs">
    {wiki ? <small>{t("Wiki status")}: {wiki.status}</small> : null}
    <div className="learning-review-toolbar">
      <Button size="sm" disabled={busy} onClick={() => void act(async () => {const result = await compileMemoryWiki(cwd, scope); if (alive.current) setWiki(result);})}>{t("Rebuild Wiki")}</Button>
      <Button size="sm" variant="ghost" disabled={busy || wiki?.status !== "ready"} onClick={() => void act(async () => {
        const result = await exportMemoryWiki(cwd, scope);
        if (!alive.current) return;
        const url = URL.createObjectURL(new Blob([result.markdown], {type: "text/markdown;charset=utf-8"}));
        const link = document.createElement("a"); link.href = url; link.download = result.fileName; document.body.append(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      })}>{t("Export Markdown")}</Button>
    </div>
    {wiki?.status === "stale" ? <InlineFeedback tone="info">{t("Sources changed. Rebuild to view current knowledge.")}</InlineFeedback> : null}
    <Field label={t("Search Wiki")}><Input value={query} onChange={e => setQuery(e.target.value)} /></Field>
    <Field label={t("Topic")}><Select value={topic} onChange={e => setTopic(e.target.value)}>
      <option value="">{t("All topics")}</option>{wiki?.topics.map(entry => <option key={entry.key} value={entry.key}>{entry.key} ({entry.pageIds.length})</option>)}
    </Select></Field>
    {pages?.map(page => <details key={page.id} id={page.id}><summary>{page.title}</summary>
      <pre>{page.body}</pre><small>{page.sourceType}:{page.sourceId} · {page.sourceVersion} · {page.confidence} · {page.updatedAt}</small>
      <ul>{page.relatedIds.map(id => <li key={id}><a href={`#${id}`}>{wiki?.pages.find(p => p.id === id)?.title}</a></li>)}</ul>
    </details>)}
    {wiki?.status === "ready" && wiki.pages.length === 0 ? <small>{t("No traceable approved knowledge in this scope")}</small> : null}
    <details><summary>{t("Source index")}</summary><ul>{wiki?.sources.map(entry => <li key={entry.key}>{entry.key}</li>)}</ul></details>
    <details><summary>{t("Knowledge reports")}</summary>
      <p>{t("Reports show explicit conflict tags, missing evidence, expiry and replacement. They do not detect semantic contradictions.")}</p>
      <ul>{wiki?.reports.map(report => <li key={`${report.sourceId}:${report.kind}`}>{report.kind} · {report.title}</li>)}</ul>
    </details>
    <Field label={t("Human notes")}><Textarea value={notes} rows={3} maxLength={16384} disabled={busy} onChange={e => setNotes(e.target.value)} /></Field>
    <small>{t("Notes survive rebuilds and never change active memory.")}</small>
    <Button size="sm" disabled={busy || !wiki || notes === wiki.human.text} onClick={() => void act(async () => {
      if (!wiki) return;
      const result = await updateMemoryWikiHumanBlock(cwd, scope, {expectedRevision: wiki.human.revision, text: notes});
      if (alive.current) setWiki({...wiki, human: result.human});
    })}>{t("Save notes")}</Button>
    {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
  </div>;
}
