import { Maximize2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { CopyActionButton } from "../feedback/CopyActionButton.js";

const MAX_MERMAID_SOURCE_CHARACTERS = 40_000;
const MAX_MATH_SOURCE_CHARACTERS = 20_000;
const MERMAID_RENDER_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT_MERMAID_RENDERS = 2;

let activeMermaidRenders = 0;
const pendingMermaidRenders: Array<() => void> = [];

interface MermaidRenderState {
  readonly key: string;
  readonly svg: string;
  readonly error: string;
}

export function MermaidBlock({
  source,
  complete,
  onDeferredContentReady,
}: {
  readonly source: string;
  readonly complete: boolean;
  readonly onDeferredContentReady?: (target: Element | null) => void;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const renderGenerationRef = useRef(0);
  const instanceId = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const titleId = `ling-mermaid-title-${instanceId}`;
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [theme, setTheme] = useState<"default" | "dark">(() => currentMermaidTheme());
  const [renderState, setRenderState] = useState<MermaidRenderState>({ key: "", svg: "", error: "" });
  const renderKey = `${theme}:${stableHash(source)}`;
  const svg = renderState.key === renderKey ? renderState.svg : "";
  const error = renderState.key === renderKey ? renderState.error : "";

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !complete) {
      return undefined;
    }
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "240px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [complete]);

  useEffect(() => {
    const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) {
      return undefined;
    }
    const handleChange = (): void => setTheme(media.matches ? "dark" : "default");
    handleChange();
    media.addEventListener?.("change", handleChange);
    return () => media.removeEventListener?.("change", handleChange);
  }, []);

  useEffect(() => {
    if (!expanded) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setExpanded(false);
      }
    };
    globalThis.addEventListener?.("keydown", handleKeyDown);
    globalThis.requestAnimationFrame?.(() => closeButtonRef.current?.focus());
    return () => globalThis.removeEventListener?.("keydown", handleKeyDown);
  }, [expanded]);

  useEffect(() => {
    if (!complete || !visible || renderState.key === renderKey) {
      return undefined;
    }
    const generation = renderGenerationRef.current + 1;
    renderGenerationRef.current = generation;
    if (source.length > MAX_MERMAID_SOURCE_CHARACTERS) {
      setRenderState({ key: renderKey, svg: "", error: "Diagram source is too large to render." });
      return undefined;
    }
    let cancelled = false;
    void withMermaidRenderSlot(async () => {
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme,
        htmlLabels: false,
      });
      await mermaid.parse(source, { suppressErrors: false });
      const rendered = await withTimeout(
        mermaid.render(`ling-mermaid-${stableHash(source)}-${instanceId}-${generation}`, source),
        MERMAID_RENDER_TIMEOUT_MS,
        "Diagram rendering timed out.",
      );
      return sanitizeMermaidSvg(rendered.svg);
    }).then((renderedSvg) => {
      if (!cancelled && renderGenerationRef.current === generation) {
        setRenderState({ key: renderKey, svg: renderedSvg, error: "" });
        notifyAfterLayout(containerRef.current, onDeferredContentReady);
      }
    }).catch((renderError) => {
      if (!cancelled && renderGenerationRef.current === generation) {
        setRenderState({
          key: renderKey,
          svg: "",
          error: renderError instanceof Error ? renderError.message : String(renderError),
        });
        notifyAfterLayout(containerRef.current, onDeferredContentReady);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [complete, instanceId, onDeferredContentReady, renderKey, renderState.key, source, theme, visible]);

  return (
    <>
      <figure
        ref={containerRef}
        className="message-mermaid-block"
        data-rich-content="mermaid"
        data-render-status={!complete ? "incomplete" : svg ? "rendered" : error ? "error" : visible ? "rendering" : "deferred"}
      >
        <figcaption>
          <span>mermaid</span>
          <span className="message-rich-block-actions">
            {svg ? (
              <button className="message-rich-icon-button" type="button" onClick={() => setExpanded(true)} aria-label="Expand diagram" title="Expand diagram">
                <Maximize2 size={14} />
              </button>
            ) : null}
            <CopyActionButton text={source} label="Copy Mermaid source" className="message-code-copy" />
          </span>
        </figcaption>
        {svg ? <div className="message-mermaid-canvas" dangerouslySetInnerHTML={{ __html: svg }} /> : (
          <div className="message-rich-source-fallback">
            {error ? <small role="status">Diagram preview unavailable</small> : null}
            <pre className={error ? "message-mermaid-source error" : "message-mermaid-source"} title={error || undefined}>
              <code>{source}</code>
            </pre>
          </div>
        )}
      </figure>
      {expanded && svg ? (
        <div className="message-rich-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) {
            setExpanded(false);
          }
        }}>
          <section className="message-rich-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
            <header>
              <strong id={titleId}>Diagram</strong>
              <span className="message-rich-dialog-actions">
                <CopyActionButton text={source} label="Copy Mermaid source" className="message-code-copy" />
                <button ref={closeButtonRef} className="message-rich-icon-button" type="button" onClick={() => setExpanded(false)} aria-label="Close diagram" title="Close">
                  <X size={15} />
                </button>
              </span>
            </header>
            <div className="message-mermaid-expanded" dangerouslySetInnerHTML={{ __html: svg }} />
          </section>
        </div>
      ) : null}
    </>
  );
}

export function MathContent({
  source,
  display,
  complete = true,
  onDeferredContentReady,
}: {
  readonly source: string;
  readonly display: boolean;
  readonly complete?: boolean;
  readonly onDeferredContentReady?: (target: Element | null) => void;
}): React.JSX.Element {
  const containerRef = useRef<HTMLElement | null>(null);
  const [html, setHtml] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setHtml("");
    setError("");
  }, [display, source]);
  useEffect(() => {
    if (!complete || html || error) {
      return undefined;
    }
    if (source.length > MAX_MATH_SOURCE_CHARACTERS) {
      setError("Math source is too large to render.");
      return undefined;
    }
    let cancelled = false;
    void import("katex").then(({ default: katex }) => {
      const rendered = katex.renderToString(source, {
        displayMode: display,
        throwOnError: true,
        strict: "warn",
        trust: false,
        output: "htmlAndMathml",
      });
      if (!cancelled) {
        setHtml(rendered);
        notifyAfterLayout(containerRef.current, onDeferredContentReady);
      }
    }).catch((renderError) => {
      if (!cancelled) {
        setError(renderError instanceof Error ? renderError.message : String(renderError));
        notifyAfterLayout(containerRef.current, onDeferredContentReady);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [complete, display, error, html, onDeferredContentReady, source]);
  if (!complete || error || !html) {
    return display
      ? <div ref={(node) => { containerRef.current = node; }} className="message-math-block source" data-rich-content="math" title={error || undefined}>{source}</div>
      : <span ref={(node) => { containerRef.current = node; }} className="message-inline-math source" data-rich-content="math" title={error || undefined}>{source}</span>;
  }
  return display
    ? <div ref={(node) => { containerRef.current = node; }} className="message-math-block" data-rich-content="math" dangerouslySetInnerHTML={{ __html: html }} />
    : <span ref={(node) => { containerRef.current = node; }} className="message-inline-math" data-rich-content="math" dangerouslySetInnerHTML={{ __html: html }} />;
}

async function withMermaidRenderSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeMermaidRenders >= MAX_CONCURRENT_MERMAID_RENDERS) {
    await new Promise<void>((resolve) => pendingMermaidRenders.push(resolve));
  }
  activeMermaidRenders += 1;
  try {
    return await task();
  } finally {
    activeMermaidRenders -= 1;
    pendingMermaidRenders.shift()?.();
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function sanitizeMermaidSvg(svg: string): string {
  if (typeof document === "undefined") {
    return svg;
  }
  const template = document.createElement("template");
  template.innerHTML = svg;
  template.content.querySelectorAll("script, foreignObject").forEach((node) => node.remove());
  template.content.querySelectorAll("*").forEach((node) => {
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        node.removeAttribute(attribute.name);
        continue;
      }
      if (name === "href" || name === "xlink:href") {
        const value = attribute.value.trim();
        if (!value.startsWith("#") && !isSafeHttpUrl(value)) {
          node.removeAttribute(attribute.name);
        }
      }
    }
  });
  return template.innerHTML;
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value, globalThis.location?.href ?? "http://localhost");
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function notifyAfterLayout(
  target: Element | null,
  callback: ((target: Element | null) => void) | undefined,
): void {
  if (!callback) {
    return;
  }
  if (typeof requestAnimationFrame === "undefined") {
    callback(target);
    return;
  }
  requestAnimationFrame(() => callback(target));
}

function currentMermaidTheme(): "default" | "dark" {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "default";
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
