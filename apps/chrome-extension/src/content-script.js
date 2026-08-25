(() => {
  if (globalThis.__lingChromeContentScriptInstalled) return;
  globalThis.__lingChromeContentScriptInstalled = true;

  let snapshotRevision = "";
  let refSequence = 0;
  let refs = new Map();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (message?.type === "ling_snapshot") sendResponse(snapshot());
      else if (message?.type === "ling_click") sendResponse(clickRef(message));
      else if (message?.type === "ling_type") sendResponse(typeRef(message));
      else return false;
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  });

  function snapshot() {
    snapshotRevision = crypto.randomUUID();
    refSequence = 0;
    refs = new Map();
    const elements = [];
    for (const element of document.querySelectorAll(
      "a[href],button,input,textarea,select,[role='button'],[role='link'],[contenteditable='true']",
    )) {
      if (elements.length >= 300 || !visible(element)) continue;
      const ref = `e${++refSequence}`;
      refs.set(ref, element);
      elements.push({
        ref,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") ?? implicitRole(element),
        label: labelFor(element).slice(0, 512),
        disabled: "disabled" in element ? element.disabled === true : false,
        sensitive: element instanceof HTMLInputElement && element.type === "password",
      });
    }
    return {
      ok: true,
      url: location.href,
      title: document.title.slice(0, 512),
      snapshotRevision,
      text: visibleText().slice(0, 64 * 1024),
      elements,
    };
  }

  function clickRef(message) {
    const element = currentRef(message);
    if (!(element instanceof HTMLElement) || isDisabled(element)) throw new Error("Element cannot be clicked");
    element.scrollIntoView({ block: "center", inline: "center" });
    element.focus({ preventScroll: true });
    element.click();
    return { ok: true, snapshotRevision };
  }

  function typeRef(message) {
    const element = currentRef(message);
    if (typeof message.text !== "string" || message.text.length > 16_384) throw new Error("Text exceeds the safe limit");
    if (element instanceof HTMLInputElement && (element.type === "password" || element.type === "file")) {
      throw new Error("Sensitive and file inputs are not supported");
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.focus({ preventScroll: true });
      const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (!setter) throw new Error("Text input setter is unavailable");
      setter.call(element, message.text);
    } else if (element instanceof HTMLElement && element.isContentEditable) {
      element.focus({ preventScroll: true });
      element.textContent = message.text;
    } else {
      throw new Error("Element does not accept text");
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: message.text }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, snapshotRevision };
  }

  function currentRef(message) {
    if (!snapshotRevision || message.snapshotRevision !== snapshotRevision) throw new Error("Snapshot is stale");
    if (typeof message.ref !== "string") throw new Error("Element ref is required");
    const element = refs.get(message.ref);
    if (!element?.isConnected || !visible(element)) throw new Error("Element ref is unavailable");
    return element;
  }

  function visible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0
      && rect.width > 0 && rect.height > 0;
  }

  function visibleText() {
    return (document.body?.innerText ?? "").replace(/\n{3,}/gu, "\n\n").trim();
  }

  function labelFor(element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/u).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      if (text) return text;
    }
    const explicit = element.getAttribute("aria-label")
      ?? element.getAttribute("alt")
      ?? element.getAttribute("title");
    if (explicit) return explicit;
    if (element instanceof HTMLInputElement && element.placeholder) return element.placeholder;
    return element.textContent ?? "";
  }

  function implicitRole(element) {
    if (element instanceof HTMLAnchorElement) return "link";
    if (element instanceof HTMLButtonElement) return "button";
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return "textbox";
    if (element instanceof HTMLSelectElement) return "combobox";
    return "interactive";
  }

  function isDisabled(element) {
    return element.getAttribute("aria-disabled") === "true" || ("disabled" in element && element.disabled === true);
  }
})();
