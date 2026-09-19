import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("styles expose independent themes, stable hit areas, and approved motion", async () => {
  const index = await readFile(new URL("../dist/styles/index.css", import.meta.url), "utf8");
  const foundations = await readFile(new URL("../dist/styles/foundation-tokens.css", import.meta.url), "utf8");
  const themes = await readFile(new URL("../dist/styles/themes/built-in-themes.css", import.meta.url), "utf8");
  const buttons = await readFile(new URL("../dist/styles/controls/button.css", import.meta.url), "utf8");
  const icons = await readFile(new URL("../dist/styles/controls/icon.css", import.meta.url), "utf8");
  const forms = await readFile(new URL("../dist/styles/controls/form-controls.css", import.meta.url), "utf8");
  const switches = await readFile(new URL("../dist/styles/controls/switch.css", import.meta.url), "utf8");
  const statusFeedback = await readFile(new URL("../dist/styles/feedback/status-feedback.css", import.meta.url), "utf8");
  const compact = await readFile(new URL("../dist/styles/desktop/compact-window.css", import.meta.url), "utf8");
  const overlays = await readFile(new URL("../dist/styles/overlays/dialog-drawer.css", import.meta.url), "utf8");
  const popover = await readFile(new URL("../dist/styles/overlays/popover.css", import.meta.url), "utf8");
  const navigation = await readFile(new URL("../dist/styles/navigation/tabs-segmented.css", import.meta.url), "utf8");
  const collapsible = await readFile(new URL("../dist/styles/navigation/collapsible.css", import.meta.url), "utf8");
  const themePicker = await readFile(new URL("../dist/styles/theme/theme-picker.css", import.meta.url), "utf8");
  const themeStudioPreview = await readFile(new URL("../dist/styles/theme/theme-studio-preview.css", import.meta.url), "utf8");

  assert.match(index, /@layer ling\.reset/u);
  assert.match(foundations, /--ling-control-sm:\s*32px/u);
  assert.match(foundations, /--ling-motion-attention:\s*600ms/u);
  assert.match(foundations, /--ling-z-dialog: 60/u);
  assert.match(foundations, /--ling-z-popover: 70/u);
  assert.match(foundations, /--ling-z-toast: 80/u);
  assert.match(themes, /data-ui-theme="ling-light"/u);
  assert.match(themes, /data-ui-theme="ling-dark"/u);
  assert.match(buttons, /--ling-control-sm/u);
  assert.match(buttons, /--ling-button-leading-size/u);
  assert.match(buttons, /--ling-button-label-display/u);
  assert.match(buttons, /data-icon-only="true"[^}]*gap:\s*0/su);
  assert.match(buttons, /data-icon-only="true"[^}]*width:\s*var\(--ling-control-sm\);[^}]*min-width:\s*var\(--ling-control-sm\)/su);
  assert.match(buttons, /data-icon-only="true"\] \.ling-ui-button-label[^}]*display:\s*none/su);
  assert.match(index, /controls\/icon\.css/u);
  assert.match(icons, /\.ling-ui-icon\s*\{[^}]*color:\s*currentColor;[^}]*stroke:\s*currentColor;/su);
  assert.match(icons, /data-size="xs"[^}]*--ling-icon-size:\s*14px;[^}]*--ling-icon-stroke-width:\s*2;/su);
  assert.match(icons, /data-size="sm"[^}]*--ling-icon-size:\s*16px;[^}]*--ling-icon-stroke-width:\s*2;/su);
  assert.match(icons, /data-size="md"[^}]*--ling-icon-size:\s*18px;[^}]*--ling-icon-stroke-width:\s*1\.75;/su);
  assert.match(icons, /data-size="lg"[^}]*--ling-icon-size:\s*20px;[^}]*--ling-icon-stroke-width:\s*1\.75;/su);
  assert.match(icons, /data-size="xl"[^}]*--ling-icon-size:\s*24px;[^}]*--ling-icon-stroke-width:\s*1\.75;/su);
  assert.match(icons, /data-tone="muted"[^}]*color:\s*var\(--ling-text-muted\);/su);
  assert.match(icons, /data-tone="success"[^}]*color:\s*var\(--ling-status-success\);/su);
  assert.match(icons, /data-tone="warning"[^}]*color:\s*var\(--ling-status-warning\);/su);
  assert.match(icons, /data-tone="danger"[^}]*color:\s*var\(--ling-status-danger\);/su);
  assert.match(icons, /data-tone="info"[^}]*color:\s*var\(--ling-status-info\);/su);
  assert.doesNotMatch(icons, /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/iu);
  assert.doesNotMatch(icons, /\b(?:animation|transition)(?:-[a-z-]+)?\s*:/u);
  assert.match(forms, /height: var\(--ling-control-md\)/u);
  assert.match(forms, /min-height: 88px/u);
  assert.match(forms, /data-invalid="true"/u);
  assert.match(
    forms,
    /:focus-within[^{}]*\{[^}]*border-color:\s*var\(--ling-border-focus\);[^}]*box-shadow:\s*inset 0 0 0 1px var\(--ling-border-focus\);/su,
  );
  assert.doesNotMatch(forms, /:focus-within[^{}]*\{[^}]*box-shadow:\s*0 0 0 [23]px/su);
  assert.match(forms, /\.ling-ui-input\s*\{[^}]*overflow:\s*hidden;/su);
  assert.match(forms, /\.ling-ui-input-native,[^{}]*\.ling-ui-select-native\s*\{[^}]*min-height:\s*0;[^}]*margin:\s*0;/su);
  assert.match(forms, /forced-colors: active/u);
  assert.match(switches, /width: var\(--ling-control-sm\)/u);
  assert.match(switches, /data-state="checked"/u);
  assert.match(statusFeedback, /data-compact="true"[^}]*position:\s*relative/su);
  assert.match(statusFeedback, /data-compact="true"\] \.ling-ui-status-indicator-label[^}]*top:\s*0[^}]*left:\s*0/su);
  assert.match(compact, /min-width: 320px/u);
  assert.match(compact, /height: var\(--ling-control-md\)/u);
  assert.match(overlays, /width: min\(360px/u);
  assert.match(overlays, /width: min\(520px/u);
  assert.match(overlays, /width: min\(720px/u);
  assert.match(overlays, /width: min\(320px/u);
  assert.match(overlays, /width: min\(400px/u);
  assert.match(overlays, /width: min\(480px/u);
  assert.match(overlays, /prefers-reduced-motion: reduce/u);
  assert.match(overlays, /data-state="closed"/u);
  assert.match(overlays, /min-height: var\(--ling-control-sm\)/u);
  assert.match(popover, /var\(--radix-popover-content-available-height\)/u);
  assert.match(popover, /data-state="closed"/u);
  assert.match(popover, /prefers-reduced-motion: reduce/u);
  assert.match(navigation, /ling-ui-tabs-list/u);
  assert.match(navigation, /data-appearance="contained"/u);
  assert.match(navigation, /data-state="on"/u);
  assert.match(navigation, /prefers-reduced-motion: reduce/u);
  assert.match(collapsible, /--radix-collapsible-content-height/u);
  assert.match(collapsible, /prefers-reduced-motion: reduce/u);
  assert.match(themePicker, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/u);
  assert.match(themePicker, /--ling-theme-option-app/u);
  assert.match(themePicker, /data-state="on"/u);
  assert.match(themePicker, /prefers-reduced-motion: reduce/u);
  assert.match(index, /theme\/theme-studio-preview\.css/u);
  assert.match(themeStudioPreview, /width: var\(--ling-theme-studio-preview-width\)/u);
  assert.match(themeStudioPreview, /height: var\(--ling-theme-studio-preview-height\)/u);
  assert.match(themeStudioPreview, /transform: scale\(var\(--ling-theme-studio-preview-scale\)\)/u);
  assert.match(themeStudioPreview, /overflow: auto/u);
  assert.match(themeStudioPreview, /prefers-reduced-motion: reduce/u);
  assert.doesNotMatch(`${index}${themes}${buttons}${icons}${forms}${switches}${statusFeedback}${compact}${overlays}${popover}${navigation}${collapsible}${themePicker}${themeStudioPreview}`, /transition:\s*all/u);
  assert.doesNotMatch(compact, /prefers-color-scheme/u);
});

test("continuous loading motion uses shared semantic duration tokens", async () => {
  const foundations = await readFile(new URL("../dist/styles/foundation-tokens.css", import.meta.url), "utf8");
  const statusFeedback = await readFile(new URL("../dist/styles/feedback/status-feedback.css", import.meta.url), "utf8");
  const toast = await readFile(new URL("../dist/styles/feedback/toast.css", import.meta.url), "utf8");
  const dataDisplay = await readFile(new URL("../dist/styles/feedback/data-display.css", import.meta.url), "utf8");
  const continuousOwners = `${statusFeedback}${toast}${dataDisplay}`;

  assert.match(foundations, /--ling-motion-continuous-spin:\s*900ms/u);
  assert.match(foundations, /--ling-motion-continuous-spin-reduced:\s*1800ms/u);
  assert.match(foundations, /--ling-motion-continuous-shimmer:\s*1400ms/u);
  assert.match(
    statusFeedback,
    /animation:\s*ling-ui-spinner-rotate\s+var\(--ling-motion-continuous-spin\)\s+var\(--ling-ease-linear\)\s+infinite/u,
  );
  assert.match(
    statusFeedback,
    /prefers-reduced-motion:\s*reduce[\s\S]*animation-duration:\s*var\(--ling-motion-continuous-spin-reduced\)/u,
  );
  assert.match(
    toast,
    /data-tone="loading"[^\n]*animation:\s*ling-ui-spinner-rotate\s+var\(--ling-motion-continuous-spin\)\s+var\(--ling-ease-linear\)\s+infinite/u,
  );
  assert.match(
    dataDisplay,
    /animation:\s*ling-ui-skeleton-shimmer\s+var\(--ling-motion-continuous-shimmer\)\s+var\(--ling-ease-linear\)\s+infinite/u,
  );
  assert.match(
    toast,
    /prefers-reduced-motion:\s*reduce[\s\S]*data-tone="loading"[^{}]*\{[^}]*animation:\s*none;/u,
  );
  assert.match(
    dataDisplay,
    /prefers-reduced-motion:\s*reduce[\s\S]*\.ling-ui-skeleton\s*\{[^}]*animation:\s*none;[^}]*background:\s*var\(--ling-bg-subtle\);/u,
  );
  assert.doesNotMatch(continuousOwners, /\b(?:900|1400|1800)ms\b/u);
});
