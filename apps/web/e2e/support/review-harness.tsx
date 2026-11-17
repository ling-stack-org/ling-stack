import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.js";
import { ThemeProvider, useTheme } from "../../src/theme.js";
import { Button, LingUiProvider, Select } from "../../src/shared/ui/index.js";
import { DiffViewer } from "../../src/shared/conversation/blocks/DiffViewer.js";
import { ArtifactPreview } from "../../src/shared/conversation/preview/ArtifactPreview.js";
import { ReviewDraftContext, ReviewDraftShelf, useReviewDraftController } from "../../src/shared/conversation/review/ReviewDraftContext.js";
import type { ChannelMessageFileRef } from "@ling-stack/contracts";
export function mountReviewFixture() {
  const container = document.createElement("main"); container.style.cssText = "padding:20px;max-width:1100px;margin:auto"; document.body.append(container);
  const root = createRoot(container); const accepted: ChannelMessageFileRef[][] = []; const files: File[] = [];
  let deferred: (() => void) | undefined;
  function Fixture() {
    const [owner, setOwner] = useState("one"); const [fail, setFail] = useState(false); const [feedback, setFeedback] = useState(""); const [defer, setDefer] = useState(false);
    const theme = useTheme();
    const controller = useReviewDraftController(owner, async file => { files.push(file); });
    return <ReviewDraftContext.Provider value={controller}>
      <h1>Review workspace</h1><Button onClick={() => setOwner(value => value === "one" ? "two" : "one")}>Switch conversation</Button>
      <Button onClick={() => setFail(value => !value)}>Fail next send</Button><span data-review-owner>{owner}</span><span role="status">{feedback}</span>
      <Button onClick={() => setDefer(value => !value)}>Defer next send</Button><Button onClick={() => { deferred?.(); deferred = undefined; }}>Accept deferred</Button>
      <Select aria-label="Fixture theme" value={theme.resolved.themeId} onChange={event => void theme.setFixedTheme(event.target.value)}>{["ling-light", "ling-dark", "ling-breeze", "ling-night", "ling-ocean", "ling-journey"].map(id => <option key={id} value={id}>{id}</option>)}</Select>
      <DiffViewer revision="run:review:1" change={{ id: "code", path: "src/main.ts", kind: "update", status: "completed", diff: "diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,3 +1,3 @@\n old context\n-old value\n+new value\n last context" }} />
      <ReviewDraftShelf onSend={() => {
        if (fail) { setFeedback("Send failed"); return; }
        const snapshot = controller.refs; const owner = controller.owner;
        const accept = () => { accepted.push([...snapshot]); controller.acknowledge(snapshot, owner); setFeedback("Feedback accepted"); };
        if (defer) deferred = accept; else accept();
      }} />
      <ArtifactPreview cwd="/workspace" preview={{ kind: "image", ref: { source: "artifact", scope: "run", id: "test-image", label: "review.png", previewable: true }, imageUrl: "/themes/ling-ocean/salt-coast-v1-thumb.webp", truncated: false, redactionNotes: [] }} />
    </ReviewDraftContext.Provider>;
  }
  root.render(<I18nProvider><ThemeProvider><LingUiProvider><Fixture /></LingUiProvider></ThemeProvider></I18nProvider>);
  return { accepted: () => accepted, files: () => files.map(file => ({ name: file.name, size: file.size, type: file.type })), dispose: () => { root.unmount(); container.remove(); } };
}
declare global { interface Window { reviewHarness: ReturnType<typeof mountReviewFixture>; } }
