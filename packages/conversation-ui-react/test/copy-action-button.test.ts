import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { CopyActionButton } from "../dist/index.js";

test("copy action uses the shared Radix tooltip contract", () => {
  const html = renderToStaticMarkup(React.createElement(CopyActionButton, {
    label: "Copy code",
    copiedLabel: "Copied code",
    text: "const answer = 42;",
  }));

  assert.match(html, /aria-label="Copy code"/u);
  assert.match(html, /data-state="closed"/u);
  assert.doesNotMatch(html, /data-tooltip=/u);
  assert.doesNotMatch(html, /title="Copy code"/u);
});
