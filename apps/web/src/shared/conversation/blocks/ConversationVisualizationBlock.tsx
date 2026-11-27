import { createInteractiveHtmlPreviewDocument, HTML_INTERACTIVE_SANDBOX, type ConversationVisualization, type ConversationVisualizationReference } from "@ling-stack/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { daemonClient } from "../../../api/client.js";
import { useI18n } from "../../../i18n.js";
import { useTheme } from "../../../theme.js";
import { Button, Dialog, DialogBody, DialogContent, DialogHeader } from "../../ui/index.js";
import { notifyConversationDeferredContentReady } from "./deferred-rendering.js";

interface VisualizationMessage {
  readonly threadId: string;
  readonly messageId: string;
  readonly messageRevision: number;
}

type LoadState = { readonly kind: "loading" } | { readonly kind: "unavailable" } |
  { readonly kind: "ready"; readonly document: ConversationVisualization };

export function ConversationVisualizationBlock({ cwd, message, reference }: {
  readonly cwd: string;
  readonly message: VisualizationMessage;
  readonly reference: ConversationVisualizationReference;
}): React.JSX.Element {
  const { t } = useI18n();
  const root = useRef<HTMLElement>(null);
  const expand = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [inlineScriptDigest, setInlineScriptDigest] = useState<string>();
  const { artifactId, label } = reference;
  const { threadId, messageId, messageRevision } = message;

  useEffect(() => {
    const target = root.current;
    if (!target) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "160px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    void loadVisualization(cwd, threadId, messageId, messageRevision, artifactId)
      .then(document => {
        if (active) setState(document.artifactId === artifactId ? { kind: "ready", document } : { kind: "unavailable" });
      }, () => { if (active) setState({ kind: "unavailable" }); });
    return () => { active = false; };
  }, [cwd, threadId, messageId, messageRevision, artifactId, visible, reload]);

  useEffect(() => {
    notifyConversationDeferredContentReady(root.current);
  }, [state.kind, expanded]);

  const document = state.kind === "ready" ? state.document : undefined;
  const allowInlineScripts = document?.interaction === "script" && inlineScriptDigest === document.sha256;
  const open = (): void => {
    setInlineScriptDigest(undefined);
    setExpanded(true);
  };
  const close = (): void => {
    setExpanded(false);
    requestAnimationFrame(() => expand.current?.focus());
  };
  return (
    <figure ref={root} className="conversation-visualization" data-visualization-layout={document?.layout ?? "standard"}>
      <figcaption className="conversation-visualization-caption">
        <strong>{document?.title ?? label}</strong>
        {document ? <Button ref={expand} variant="ghost" size="sm" onClick={open}>{t("Expand")}</Button> : null}
      </figcaption>
      {document ? (
        <>
          <p className="conversation-visualization-summary">{document.summary}</p>
          {!expanded && document.interaction === "script" ? (
            <VisualizationScriptControl enabled={allowInlineScripts}
              onToggle={() => setInlineScriptDigest(allowInlineScripts ? undefined : document.sha256)} />
          ) : null}
          {expanded
            ? <div style={{ blockSize: document.preferredHeight }} aria-hidden="true" />
            : <VisualizationFrame document={document} allowScripts={allowInlineScripts} />}
          {expanded ? <ExpandedVisualization key={document.sha256} document={document} onClose={close} /> : null}
        </>
      ) : state.kind === "unavailable" ? (
        <div className="conversation-visualization-status">
          <span>{t("Preview unavailable")}</span>
          <Button variant="ghost" size="sm" onClick={() => { setState({ kind: "loading" }); setReload(value => value + 1); }}>{t("Retry preview")}</Button>
        </div>
      ) : <span className="conversation-visualization-status" role="status">{t("Loading preview...")}</span>}
    </figure>
  );
}

function ExpandedVisualization({ document, onClose }: {
  readonly document: ConversationVisualization;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [allowScripts, setAllowScripts] = useState(false);
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent size="lg" className="conversation-visualization-dialog">
        <DialogHeader title={document.title} closeLabel={t("Close preview")} />
        <DialogBody>
          <p className="conversation-visualization-summary">{document.summary}</p>
          {document.interaction === "script" ? (
            <VisualizationScriptControl enabled={allowScripts} onToggle={() => setAllowScripts(value => !value)} />
          ) : null}
          <VisualizationFrame document={document} allowScripts={allowScripts} expanded />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function VisualizationScriptControl({ enabled, onToggle }: {
  readonly enabled: boolean;
  readonly onToggle: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="conversation-visualization-script-controls">
      <Button size="sm" variant="secondary" onClick={onToggle}>
        {t(enabled ? "Stop interactive preview" : "Run interactive preview")}
      </Button>
      <p className="conversation-visualization-summary">{t("Scripts can contact external services. Only run documents you trust.")}</p>
    </div>
  );
}

function VisualizationFrame({ document, allowScripts, expanded = false }: {
  readonly document: ConversationVisualization;
  readonly allowScripts: boolean;
  readonly expanded?: boolean;
}): React.JSX.Element {
  const { resolvedTheme } = useTheme();
  const colorScheme = resolvedTheme === "dark" ? "dark" : "light";
  const srcDoc = useMemo(() => createInteractiveHtmlPreviewDocument(document.html, document.title, allowScripts, colorScheme),
    [document.html, document.title, allowScripts, colorScheme]);
  return (
    <iframe
      key={String(allowScripts)}
      className="conversation-visualization-frame"
      data-conversation-visualization-frame={expanded ? "expanded" : "inline"}
      title={document.title}
      sandbox={allowScripts ? HTML_INTERACTIVE_SANDBOX.join(" ") : ""}
      srcDoc={srcDoc}
      style={{ blockSize: expanded ? "min(60dvh, 800px)" : document.preferredHeight }}
    />
  );
}

const pending = new Map<string, Promise<ConversationVisualization>>();

function loadVisualization(cwd: string, threadId: string, messageId: string, revision: number, artifactId: string): Promise<ConversationVisualization> {
  const key = JSON.stringify([cwd, threadId, messageId, revision, artifactId]);
  const existing = pending.get(key);
  if (existing) return existing;
  const request = daemonClient.getConversationVisualization(cwd, threadId, messageId, revision, artifactId)
    .finally(() => { if (pending.get(key) === request) pending.delete(key); });
  pending.set(key, request);
  return request;
}
