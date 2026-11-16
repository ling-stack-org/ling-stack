/** This fixed program runs in Chromium's isolated world; no page script or model code is evaluated. */
export function browserPageProgram(request: { readonly action: "snapshot" | "click" | "type" | "invalidate"; readonly revision?: string; readonly ref?: string; readonly text?: string }): unknown {
  type Entry = { readonly node: HTMLElement; readonly signature: string };
  type State = { revision: string; readonly refs: Map<string, Entry>; readonly observer: MutationObserver };
  const root = globalThis as typeof globalThis & { __lingBrowserPage?: State };
  const invalidate = (state: State): void => { state.revision = ""; state.refs.clear(); };
  if (!root.__lingBrowserPage) {
    const state: State = { revision: "", refs: new Map(), observer: new MutationObserver(() => invalidate(state)) };
    state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    root.__lingBrowserPage = state;
  }
  const state = root.__lingBrowserPage;
  if (state.observer.takeRecords().length) invalidate(state);
  if (request.action === "invalidate") { invalidate(state); return { ok: true }; }
  const sensitive = (node: Element): boolean => {
    const input = node instanceof HTMLInputElement ? node : undefined;
    return Boolean(input && !["text", "search", "email", "tel", "url", "number", "button", "submit", "reset", "checkbox", "radio"].includes(input.type))
      || /(?:password|cc-|credit|one-time-code|transaction)/iu.test(node.getAttribute("autocomplete") ?? "");
  };
  const label = (node: HTMLElement): string => (node.getAttribute("aria-label") || node.getAttribute("title")
    || (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? [...(node.labels ?? [])].map(item => item.innerText).join(" ") || node.placeholder : node.innerText)
    || node.getAttribute("name") || "").replace(/\s+/gu, " ").slice(0, 512);
  const signature = (node: HTMLElement): string => JSON.stringify([node.tagName, node.getAttribute("type"), node.getAttribute("href"), node.getAttribute("role"), label(node), node.getAttribute("autocomplete")]);
  const rect = (node: Element): DOMRect => node.getBoundingClientRect();
  const visible = (node: Element): boolean => {
    const box = rect(node), style = getComputedStyle(node);
    return box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth
      && style.visibility === "visible" && style.display !== "none" && style.opacity !== "0";
  };
  if (request.action === "snapshot") {
    invalidate(state);
    state.revision = request.revision!;
    const elements: { ref: string; tag: string; role: string; label: string; disabled: boolean; sensitive: boolean }[] = [];
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT);
    let node: Node | null = walker.currentNode, visited = 0;
    while (node && visited++ < 10_000 && elements.length < 300) {
      if (node instanceof HTMLElement && visible(node) && node.matches("a[href],button,input,textarea,select,[role=button],[role=link],[contenteditable=true]")) {
        const ref = `e${elements.length + 1}`;
        state.refs.set(ref, { node, signature: signature(node) });
        elements.push({ ref, tag: node.tagName.toLowerCase(), role: node.getAttribute("role") ?? "", label: label(node),
          disabled: node.matches(":disabled,[aria-disabled=true]"), sensitive: sensitive(node) });
      }
      node = walker.nextNode();
    }
    const texts = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    let text = "", textNode: Node | null, count = 0;
    while ((textNode = texts.nextNode()) && count++ < 10_000 && text.length < 65_536) {
      const parent = textNode.parentElement;
      if (parent && !parent.closest("script,style,noscript,textarea,input,[contenteditable=true]") && visible(parent)) {
        text += `${textNode.textContent?.replace(/\s+/gu, " ").trim() ?? ""}\n`;
      }
    }
    return { snapshotRevision: state.revision, text: text.slice(0, 65_536), elements,
      coverage: "main_document_visible_viewport; frames, shadow roots and canvas are not traversed" };
  }
  if (!state.revision || state.revision !== request.revision) throw new Error("browser_snapshot_stale");
  const entry = state.refs.get(request.ref!);
  if (!entry || !entry.node.isConnected || !visible(entry.node) || signature(entry.node) !== entry.signature) throw new Error("browser_ref_stale");
  const node = entry.node;
  if (sensitive(node)) throw new Error("browser_sensitive_input_forbidden");
  if (node.matches(":disabled,[aria-disabled=true],[readonly],[aria-readonly=true]")) throw new Error("browser_element_disabled");
  const box = rect(node), x = Math.max(0, Math.min(innerWidth - 1, box.left + box.width / 2)), y = Math.max(0, Math.min(innerHeight - 1, box.top + box.height / 2));
  const hit = document.elementFromPoint(x, y);
  if (!hit || (hit !== node && !node.contains(hit))) throw new Error("browser_element_obscured");
  if (request.action === "type" && !(node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement && ["text", "search", "email", "tel", "url", "number"].includes(node.type))) {
    throw new Error("browser_element_not_text_input");
  }
  invalidate(state);
  if (request.action === "click") node.click();
  else {
    const prototype = node instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, request.text ?? "");
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return { ok: true, snapshotInvalidated: true };
}

export function browserPageScript(request: Parameters<typeof browserPageProgram>[0]): string {
  return `(() => { try { return { ok: true, value: (${browserPageProgram.toString()})(${JSON.stringify(request)}) }; }
    catch (error) { return { ok: false, error: error instanceof Error && /^browser_[a-z_]+$/.test(error.message) ? error.message : "browser_page_execution_failed" }; } })()`;
}
