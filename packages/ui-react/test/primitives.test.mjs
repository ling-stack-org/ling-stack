import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Search } from "lucide-react";
import { createElement } from "react";
import { createPortal } from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Button,
  Badge,
  Checkbox,
  CompactDesktopWindow,
  CompactWindowHeader,
  CompactWindowStatusOverlay,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  CurrentSessionCapabilityControl,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DataRow,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  Field,
  EmptyState,
  Icon,
  IconButton,
  Input,
  InlineFeedback,
  InspectorSection,
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
  OverlayPortalProvider,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SegmentedControl,
  SegmentedControlItem,
  Select,
  Skeleton,
  SplitButton,
  SplitButtonPrimary,
  SplitButtonTrigger,
  StatusIndicator,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeaderCell,
  TableRow,
  Textarea,
  ThemePicker,
  Tooltip,
  TooltipProvider,
  Toast,
  ToastProvider,
  ToastViewport,
  useToast,
} from "../dist/index.js";

test("tooltip exposes one app-level provider instead of creating a provider per trigger", () => {
  assert.equal(typeof TooltipProvider, "function");
  assert.equal(typeof Tooltip, "function");
});

test("overlays expose one application-owned portal provider", () => {
  assert.equal(typeof OverlayPortalProvider, "function");
});

test("dialog and drawer expose one composable overlay contract", () => {
  assert.equal(typeof Dialog, "function");
  assert.equal(typeof DialogContent, "object");
  assert.equal(typeof DialogHeader, "object");
  assert.equal(typeof Drawer, "function");
  assert.equal(typeof DrawerContent, "object");
  assert.equal(DrawerHeader, DialogHeader);
  assert.equal(DrawerBody, DialogBody);
  assert.equal(DrawerFooter, DialogFooter);

  const bodyHtml = renderToStaticMarkup(createElement(DialogBody, null, "Scrollable content"));
  const footerHtml = renderToStaticMarkup(createElement(DialogFooter, null, "Actions"));
  assert.match(bodyHtml, /class="ling-ui-dialog-body"/u);
  assert.match(footerHtml, /class="ling-ui-dialog-footer"/u);
});

test("popover exposes one portal-backed lightweight overlay contract", () => {
  assert.equal(typeof Popover, "function");
  assert.equal(typeof PopoverTrigger, "object");
  assert.equal(typeof PopoverContent, "object");
});

test("menu exposes a semantic single-choice contract", () => {
  assert.equal(typeof Menu, "function");
  assert.equal(typeof MenuTrigger, "object");
  assert.equal(typeof MenuContent, "object");
  assert.equal(typeof MenuRadioGroup, "object");
  assert.equal(typeof MenuRadioItem, "object");
});

test("tabs expose semantic selection without changing the list geometry", () => {
  const html = renderToStaticMarkup(createElement(
    Tabs,
    { value: "skills" },
    createElement(
      TabsList,
      { "aria-label": "Settings sections", appearance: "contained", size: "sm" },
      createElement(TabsTrigger, { value: "skills" }, "Skills"),
      createElement(TabsTrigger, { value: "archive" }, "Archived"),
    ),
    createElement(TabsContent, { value: "skills" }, "Skill content"),
  ));

  assert.match(html, /role="tablist"/u);
  assert.match(html, /data-appearance="contained"/u);
  assert.match(html, /data-size="sm"/u);
  assert.match(html, /role="tab" aria-selected="true"/u);
  assert.match(html, /class="ling-ui-tabs-content"/u);
});

test("segmented control keeps exactly one semantic view selection", () => {
  const html = renderToStaticMarkup(createElement(
    SegmentedControl,
    { "aria-label": "Media view", value: "studio" },
    createElement(SegmentedControlItem, { value: "studio" }, "Studio"),
    createElement(SegmentedControlItem, { value: "jobs" }, "Jobs"),
  ));

  assert.match(html, /role="radiogroup"/u);
  assert.match(html, /role="radio" aria-checked="true"/u);
  assert.match(html, /data-state="on"/u);
  assert.match(html, /data-state="off"/u);
});

test("theme picker exposes active, selected, applying, and unavailable theme states", () => {
  const swatch = {
    accent: "#111111",
    app: "#f7f7f7",
    danger: "#a00000",
    info: "#0055aa",
    panel: "#ffffff",
    success: "#087a45",
    text: "#171717",
    warning: "#8a5b00",
  };
  const html = renderToStaticMarkup(createElement(ThemePicker, {
    "aria-label": "Theme packs",
    activeThemeId: "ling-light",
    applyingLabel: "Applying theme",
    applyingThemeId: "quiet-ocean",
    onThemeSelect: () => undefined,
    options: [
      {
        id: "ling-light",
        name: "Ling Light",
        accessibleLabel: "Ling Light, light, built-in",
        colorSchemeLabel: "Light",
        swatch,
      },
      {
        id: "quiet-ocean",
        name: "Quiet Ocean",
        accessibleLabel: "Quiet Ocean, light, local theme",
        colorSchemeLabel: "Light",
        sourceLabel: "Local theme",
        actions: createElement("button", { type: "button" }, "Theme actions"),
        swatch,
      },
      {
        id: "unavailable",
        name: "Unavailable",
        accessibleLabel: "Unavailable theme",
        colorSchemeLabel: "Dark",
        disabled: true,
        disabledReason: "Missing asset",
        swatch,
      },
    ],
    selectedThemeId: "ling-light",
  }));

  assert.match(html, /role="radiogroup"/u);
  assert.match(html, /aria-label="Theme packs"/u);
  assert.match(html, /data-theme-option-id="ling-light"/u);
  assert.match(html, /data-active="true"/u);
  assert.match(html, /role="radio" aria-checked="true"/u);
  assert.match(html, /data-applying="true"/u);
  assert.match(html, /aria-busy="true"/u);
  assert.match(html, /aria-label="Applying theme"/u);
  assert.match(html, /Local theme/u);
  assert.match(html, /ling-ui-theme-option-actions/u);
  assert.match(html, /<\/button><span class="ling-ui-theme-option-actions"><button type="button">Theme actions<\/button>/u);
  assert.match(html, /disabled=""/u);
  assert.match(html, /Missing asset/u);
  assert.match(html, /--ling-theme-option-app:#f7f7f7/u);
});

test("collapsible exposes controlled trigger and animated content state", () => {
  const html = renderToStaticMarkup(createElement(
    Collapsible,
    { defaultOpen: true },
    createElement(CollapsibleTrigger, null, "Channels"),
    createElement(CollapsibleContent, null, "Engineering"),
  ));

  assert.match(html, /aria-expanded="true"/u);
  assert.match(html, /data-state="open"/u);
  assert.match(html, /data-ling-collapsible-content=""/u);
  assert.match(html, /Engineering/u);
});

test("button preserves its label and disables duplicate activation while loading", () => {
  const html = renderToStaticMarkup(createElement(Button, { loading: true }, "Save changes"));

  assert.match(html, /data-loading="true"/u);
  assert.match(html, /aria-busy="true"/u);
  assert.match(html, /disabled=""/u);
  assert.match(html, /Save changes/u);
  assert.match(html, /Loading/u);
  assert.match(html, /data-ling-button-slot="leading"/u);
  assert.match(html, /data-ling-button-slot="label"/u);
});

test("split button gives both actions one inherited size and one outer control frame", () => {
  const html = renderToStaticMarkup(createElement(
    SplitButton,
    { "aria-label": "Allow options", role: "group", size: "md" },
    createElement(SplitButtonPrimary, { variant: "primary" }, "Allow once"),
    createElement(SplitButtonTrigger, {
      icon: Search,
      label: "Allow options",
      variant: "primary",
    }),
  ));

  assert.match(html, /data-ling-split-button="true"/u);
  assert.match(html, /role="group"/u);
  assert.equal((html.match(/data-size="md"/gu) ?? []).length, 3);
  assert.match(html, /ling-ui-split-button-primary/u);
  assert.match(html, /ling-ui-split-button-trigger/u);
});

test("button asChild composes one interactive element without nested controls", () => {
  const html = renderToStaticMarkup(createElement(
    Button,
    { asChild: true, variant: "ghost" },
    createElement("a", { href: "/settings" }, "Open settings"),
  ));

  assert.match(html, /^<a /u);
  assert.match(html, /class="ling-ui-button"/u);
  assert.match(html, /href="\/settings"/u);
  assert.doesNotMatch(html, /<button/u);
});

test("icon button normalizes typed Lucide components and marks the legacy ReactNode path", () => {
  const typedHtml = renderToStaticMarkup(createElement(IconButton, {
    icon: Search,
    label: "Search",
    pressed: true,
  }));
  const legacyHtml = renderToStaticMarkup(createElement(IconButton, {
    icon: createElement("svg", { "data-test-icon": "search" }),
    label: "Legacy search",
  }));

  assert.match(typedHtml, /aria-label="Search"/u);
  assert.match(typedHtml, /title="Search"/u);
  assert.match(typedHtml, /aria-pressed="true"/u);
  assert.match(typedHtml, /data-icon-only="true"/u);
  assert.match(typedHtml, /data-ling-icon-button-contract="typed-lucide"/u);
  assert.match(typedHtml, /data-ling-icon=""/u);
  assert.match(typedHtml, /data-size="sm"/u);
  assert.match(typedHtml, /aria-hidden="true"/u);

  assert.match(legacyHtml, /aria-label="Legacy search"/u);
  assert.match(legacyHtml, /data-ling-icon-button-contract="legacy-react-node"/u);
  assert.match(legacyHtml, /data-test-icon="search"/u);
  assert.doesNotMatch(legacyHtml, /data-ling-icon=""/u);
});

test("icon button keeps React elements and portals out of the typed Lucide path", () => {
  const lucideElement = createElement(Search, { "data-test-icon": "element" });
  const elementButton = IconButton.render({ icon: lucideElement, label: "Element", tooltip: "" }, null);
  const portal = createPortal(createElement("svg", { "data-test-icon": "portal" }), { nodeType: 1 });
  const portalButton = IconButton.render({ icon: portal, label: "Portal", tooltip: "" }, null);

  assert.equal(elementButton.props["data-ling-icon-button-contract"], "legacy-react-node");
  assert.equal(elementButton.props.leadingIcon, lucideElement);
  assert.equal(portalButton.props["data-ling-icon-button-contract"], "legacy-react-node");
  assert.equal(portalButton.props.leadingIcon, portal);
});

test("icon button preserves loading, tooltip, pressed, and accessible-name behavior on both icon paths", () => {
  for (const [icon, contract] of [
    [Search, "typed-lucide"],
    [createElement("svg", { "aria-hidden": "true" }), "legacy-react-node"],
  ]) {
    const html = renderToStaticMarkup(createElement(IconButton, {
      icon,
      label: "Refresh",
      loading: true,
      loadingLabel: "Refreshing",
      pressed: false,
    }));

    assert.match(html, new RegExp(`data-ling-icon-button-contract="${contract}"`, "u"));
    assert.match(html, /aria-label="Refresh"/u);
    assert.match(html, /title="Refresh"/u);
    assert.match(html, /aria-pressed="false"/u);
    assert.match(html, /aria-busy="true"/u);
    assert.match(html, /disabled=""/u);
    assert.match(html, /Refreshing/u);
  }
});

test("icon button source isolates forwardRef Lucide detection from React elements and portals", async () => {
  const source = await readFile(new URL("../src/controls/IconButton.tsx", import.meta.url), "utf8");

  assert.match(source, /import type \{ LucideIcon \} from "lucide-react"/u);
  assert.match(source, /isValidElement/u);
  assert.match(source, /Symbol\.for\("react\.forward_ref"\)/u);
  assert.match(source, /data-ling-icon-button-contract/u);
  assert.match(source, /<Icon icon=\{icon\}/u);
  assert.doesNotMatch(source, /cloneElement/u);
});

test("package-owned standard IconButton actions use typed components without local geometry", async () => {
  const sources = await Promise.all([
    "../src/overlays/Dialog.tsx",
    "../src/desktop/CompactDesktopWindow.tsx",
    "../src/theme-studio/ThemeStudioPreviewFixture.tsx",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  const source = sources.join("\n");

  assert.doesNotMatch(source, /icon=\{<[^}]+\}/u);
  assert.doesNotMatch(source, /icon=\{[^}]*\b(?:size|strokeWidth|color)=/u);
  assert.match(source, /icon=\{X\}/u);
  assert.match(source, /icon=\{MoreHorizontal\}/u);
  assert.match(source, /icon=\{Search\}/u);
});

test("icon defaults to decorative semantics and exposes a named semantic mode", () => {
  const decorativeHtml = renderToStaticMarkup(createElement(Icon, { icon: Search }));
  const semanticHtml = renderToStaticMarkup(createElement(Icon, {
    decorative: false,
    icon: Search,
    label: "Search messages",
    size: "lg",
    tone: "info",
  }));

  assert.match(decorativeHtml, /class="[^"]*ling-ui-icon[^"]*"/u);
  assert.match(decorativeHtml, /data-size="sm"/u);
  assert.match(decorativeHtml, /data-tone="default"/u);
  assert.match(decorativeHtml, /aria-hidden="true"/u);
  assert.doesNotMatch(decorativeHtml, /role="img"/u);
  assert.doesNotMatch(decorativeHtml, /aria-label=/u);

  assert.match(semanticHtml, /data-size="lg"/u);
  assert.match(semanticHtml, /data-tone="info"/u);
  assert.match(semanticHtml, /role="img"/u);
  assert.match(semanticHtml, /aria-label="Search messages"/u);
  assert.doesNotMatch(semanticHtml, /aria-hidden=/u);
});

test("icon publishes only the frozen size and tone mappings", () => {
  const sizes = ["xs", "sm", "md", "lg", "xl"];
  const tones = ["default", "muted", "success", "warning", "danger", "info"];

  for (const size of sizes) {
    const html = renderToStaticMarkup(createElement(Icon, { icon: Search, size }));
    assert.match(html, new RegExp(`data-size="${size}"`, "u"));
  }

  for (const tone of tones) {
    const html = renderToStaticMarkup(createElement(Icon, { icon: Search, tone }));
    assert.match(html, new RegExp(`data-tone="${tone}"`, "u"));
  }
});

test("icon rejects contradictory or unnamed accessibility modes", () => {
  assert.throws(
    () => renderToStaticMarkup(createElement(Icon, {
      decorative: true,
      icon: Search,
      label: "Search",
    })),
    /cannot combine label with decorative=true/u,
  );
  assert.throws(
    () => renderToStaticMarkup(createElement(Icon, {
      decorative: false,
      icon: Search,
    })),
    /requires a non-empty label when decorative=false/u,
  );
});

test("icon source keeps Lucide and accessibility policy inside the primitive", async () => {
  const source = await readFile(new URL("../src/controls/Icon.tsx", import.meta.url), "utf8");

  assert.match(source, /import type \{ LucideIcon \} from "lucide-react"/u);
  assert.match(source, /readonly icon: LucideIcon/u);
  assert.match(source, /data-size=\{size\}/u);
  assert.match(source, /data-tone=\{tone\}/u);
  assert.doesNotMatch(source, /readonly (?:color|height|strokeWidth|width)\??:/u);
  assert.doesNotMatch(source, /LingStackLogo|favicon/u);
});

test("status indicator uses text in addition to its semantic tone", () => {
  const html = renderToStaticMarkup(createElement(StatusIndicator, { compact: true, label: "Ready", tone: "success" }));

  assert.match(html, /data-tone="success"/u);
  assert.match(html, /data-compact="true"/u);
  assert.match(html, />Ready</u);
});

test("switch exposes binary state and disables duplicate input while loading", () => {
  const html = renderToStaticMarkup(createElement(Switch, {
    "aria-label": "Automatically show preview",
    checked: true,
    loading: true,
  }));

  assert.match(html, /role="switch"/u);
  assert.match(html, /aria-checked="true"/u);
  assert.match(html, /aria-busy="true"/u);
  assert.match(html, /disabled=""/u);
  assert.match(html, /ling-ui-switch-thumb/u);
});

test("checkbox keeps a native input, stable checked state, and optional visible label", () => {
  const html = renderToStaticMarkup(createElement(Checkbox, {
    "aria-label": "Select GPT model",
    checked: true,
    label: "GPT model",
    readOnly: true,
  }));

  assert.match(html, /class="ling-ui-checkbox"/u);
  assert.match(html, /class="ling-ui-checkbox-native"/u);
  assert.match(html, /data-ling-control-native="true"/u);
  assert.match(html, /type="checkbox"/u);
  assert.match(html, /checked=""/u);
  assert.match(html, /aria-label="Select GPT model"/u);
  assert.match(html, />GPT model</u);
});

test("input and textarea expose stable control states without changing their accessible value", () => {
  const inputHtml = renderToStaticMarkup(createElement(Input, {
    "aria-label": "Workspace name",
    invalid: true,
    prefix: createElement("svg"),
    value: "Ling",
    readOnly: true,
  }));
  const textareaHtml = renderToStaticMarkup(createElement(Textarea, {
    "aria-label": "Description",
    loading: true,
    value: "Product context",
    readOnly: true,
  }));

  assert.match(inputHtml, /data-ling-control-native="true"/u);
  assert.match(inputHtml, /data-ling-input-native="true"/u);
  assert.match(textareaHtml, /data-ling-control-native="true"/u);

  assert.match(inputHtml, /class="ling-ui-input/u);
  assert.match(inputHtml, /aria-invalid="true"/u);
  assert.match(inputHtml, /value="Ling"/u);
  assert.match(textareaHtml, /class="ling-ui-textarea/u);
  assert.match(textareaHtml, /aria-busy="true"/u);
  assert.match(textareaHtml, />Product context<\/textarea>/u);
});

test("native select keeps compact sizing, loading semantics, and a root compatibility slot", () => {
  const html = renderToStaticMarkup(createElement(
    Select,
    {
      "aria-label": "Model",
      containerProps: { "data-select-control": "compact" },
      loading: true,
      size: "sm",
      value: "gpt-5",
    },
    createElement("option", { value: "gpt-5" }, "GPT-5"),
  ));

  assert.match(html, /class="ling-ui-select/u);
  assert.match(html, /data-select-control="compact"/u);
  assert.match(html, /data-ling-control-native="true"/u);
  assert.match(html, /data-size="sm"/u);
  assert.match(html, /aria-busy="true"/u);
  assert.match(html, /disabled=""/u);
  assert.match(html, /<option value="gpt-5" selected="">GPT-5<\/option>/u);
});

test("field connects label, description, error, required, and the control with stable ids", () => {
  const html = renderToStaticMarkup(createElement(
    Field,
    {
      controlId: "workspace-name",
      description: "Shown in conversation headers.",
      error: "Name is required.",
      label: "Workspace name",
      required: true,
    },
    createElement(Input, { name: "workspaceName" }),
  ));

  assert.match(html, /for="workspace-name"/u);
  assert.match(html, /id="workspace-name"/u);
  assert.match(html, /aria-describedby="workspace-name-description workspace-name-error"/u);
  assert.match(html, /aria-invalid="true"/u);
  assert.match(html, /required=""/u);
  assert.match(html, /Shown in conversation headers\./u);
  assert.match(html, /Name is required\./u);
});

test("inline feedback owns persistent product feedback semantics", () => {
  const html = renderToStaticMarkup(createElement(
    InlineFeedback,
    { title: "Preference not saved", tone: "warning" },
    "It may revert after restart.",
  ));

  assert.match(html, /role="status"/u);
  assert.match(html, /data-tone="warning"/u);
  assert.match(html, /class="ling-ui-inline-feedback-detail" data-ling-inline-feedback-slot="detail"/u);
  assert.match(html, /Preference not saved/u);
  assert.match(html, /It may revert after restart\./u);
});

test("toast primitives expose one provider, viewport, item, and controller contract", () => {
  assert.equal(typeof ToastProvider, "function");
  assert.equal(typeof ToastViewport, "object");
  assert.equal(typeof Toast, "object");
  assert.equal(typeof useToast, "function");
});

test("badge, empty state, and skeleton keep compact feedback geometry", () => {
  const badgeHtml = renderToStaticMarkup(createElement(Badge, { tone: "warning" }, "Needs attention"));
  const emptyHtml = renderToStaticMarkup(createElement(EmptyState, {
    compact: true,
    description: "Create the first model to continue.",
    title: "No models",
  }));
  const skeletonHtml = renderToStaticMarkup(createElement(Skeleton, { shape: "circle", width: 24, height: 24 }));

  assert.match(badgeHtml, /class="ling-ui-badge"/u);
  assert.match(badgeHtml, /data-tone="warning"/u);
  assert.match(emptyHtml, /class="ling-ui-empty-state"/u);
  assert.match(emptyHtml, /data-compact="true"/u);
  assert.match(skeletonHtml, /data-shape="circle"/u);
  assert.match(skeletonHtml, /width:24px/u);
});

test("data display primitives preserve identity, comparison, and inspector semantics", () => {
  const rowHtml = renderToStaticMarkup(createElement(DataRow, {
    identity: "GPT-5",
    selected: true,
    status: createElement(Badge, { tone: "success" }, "Ready"),
    summary: "Chat",
  }));
  const tableHtml = renderToStaticMarkup(createElement(
    TableContainer,
    null,
    createElement(
      Table,
      null,
      createElement(TableHead, null, createElement(TableRow, null, createElement(TableHeaderCell, null, "Model"))),
      createElement(TableBody, null, createElement(TableRow, null, createElement(TableCell, null, "GPT-5"))),
    ),
  ));
  const inspectorHtml = renderToStaticMarkup(createElement(
    InspectorSection,
    { open: true, summary: "2 files", title: "Evidence" },
    "Inspector content",
  ));

  assert.match(rowHtml, /class="ling-ui-data-row"/u);
  assert.match(rowHtml, /data-selected="true"/u);
  assert.match(tableHtml, /class="ling-ui-table-container"/u);
  assert.match(tableHtml, /scope="col"/u);
  assert.match(inspectorHtml, /<details open="" class="ling-ui-inspector-section">/u);
  assert.match(inspectorHtml, /Inspector content/u);
});

test("capability control keeps actions and persistent issues in an anchored owner", () => {
  const html = renderToStaticMarkup(createElement(CurrentSessionCapabilityControl, {
    label: "Computer Use",
    statusLabel: "Live",
    tone: "success",
    actions: [{ id: "hide", icon: createElement("svg"), label: "Hide preview" }],
    issue: { message: "Preview command failed", tone: "danger" },
  }));

  assert.match(html, /ling-ui-capability-control/u);
  assert.match(html, /aria-label="Hide preview"/u);
  assert.match(html, /data-ling-icon-button-contract="legacy-react-node"/u);
  assert.match(html, /role="alert"/u);
  assert.match(html, /Preview command failed/u);
});

test("compact window exposes stable shell and object-owned status", () => {
  const header = createElement(CompactWindowHeader, { title: "Example Browser", status: "Live" });
  const status = createElement(CompactWindowStatusOverlay, {
    label: "Permission required",
    detail: "Open screen settings to continue.",
    tone: "warning",
  });
  const html = renderToStaticMarkup(createElement(CompactDesktopWindow, {
    content: createElement("video"),
    header,
    label: "Computer Use preview",
    state: "attention",
    status,
  }));

  assert.match(html, /aria-label="Computer Use preview"/u);
  assert.match(html, /data-state="attention"/u);
  assert.match(html, /Permission required/u);
  assert.match(html, /Open screen settings to continue\./u);
});
