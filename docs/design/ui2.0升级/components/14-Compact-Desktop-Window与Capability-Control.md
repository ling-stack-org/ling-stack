# Compact Desktop Window 与 Capability Control

## Goal

为 Desktop-only 小窗口和主应用 Header 中的运行能力提供共享展示组件。组件负责视觉、
键盘、ARIA、主题和稳定尺寸，不负责 Electron、IPC、Computer Use 业务状态或媒体生命周期。

## Component Set

```text
CurrentSessionCapabilityControl
CompactDesktopWindow
CompactWindowHeader
CompactWindowStatusOverlay
CompactWindowActionMenu
CompactWindowIconButton
```

## CurrentSessionCapabilityControl

```ts
export interface CurrentSessionCapabilityControlProps {
  readonly label: string;
  readonly statusLabel: string;
  readonly tone: "neutral" | "success" | "warning" | "danger";
  readonly actions: readonly CapabilityAction[];
  readonly issue?: InlineFeedbackModel;
}
```

- fixed height `36px`，does not resize for loading/error；
- identity column uses `minmax(0, 1fr)` and truncates；
- actions are `32x32` IconButton；
- issue renders in an anchored Popover/feedback layer owned by the control，not inside Header flow；
- component has no Computer Use imports and can support future Desktop capabilities。

## CompactDesktopWindow

```ts
export interface CompactDesktopWindowProps {
  readonly label: string;
  readonly state: "live" | "busy" | "attention" | "terminal";
  readonly controlsVisibility: "hover-focus" | "persistent";
  readonly header: ReactNode;
  readonly content: ReactNode;
  readonly status?: ReactNode;
}
```

- fills the frameless BrowserWindow；
- outer radius is a Desktop utility-window token，default `12px`；
- border and shadow consume compact-window semantic tokens；
- content owns `overflow:hidden`；menus use Portal inside the renderer window；
- captured/media content remains outside theme filters。

## CompactWindowHeader

- height target `40px` including drag area；
- target/status at start，actions at end；
- start area is draggable，interactive controls are no-drag；
- live state can hide by opacity，not `display:none` or tab-order removal；
- long title truncates，full value available to assistive technology；
- non-live state remains persistent。

## CompactWindowIconButton

- `32x32` hit area，Lucide `14-16px`，strokeWidth from Icon system；
- default/hover/focus/active/disabled/loading/danger states match UI 2.0 Button contract；
- Tooltip opens on hover/focus，but accessible name exists without Tooltip；
- loading preserves action width and prevents duplicate activation；
- no visible text in compact header unless an action is unfamiliar and designated primary recovery。

## CompactWindowStatusOverlay

- anchored `12px` from sides/bottom，internal radius `8px`；
- one status indicator、one label、optional one-line detail、optional single recovery action；
- no card inside card，no multiple badges，no raw error stack；
- busy state uses shared Spinner；danger uses a small semantic accent only；
- at minimum width，detail truncates or wraps to two lines without covering the action；
- live compact status may hide with chrome，non-live remains visible。

## CompactWindowActionMenu

- uses shared Menu primitive and standard action icons；
- min width `168px`，row height `32px`；
- danger action separated at the end；
- keyboard navigation、Esc、outside close and focus return follow Menu contract；
- menu collision stays within the small renderer viewport；when space is insufficient it opens inward/downward
  according to available bounds。

## Theme Tokens

Compact window consumes semantic aliases only：

```text
--ling-compact-window-bg
--ling-compact-window-elevated
--ling-compact-window-text
--ling-compact-window-muted
--ling-compact-window-border
--ling-compact-window-focus
--ling-compact-window-shadow
```

Status uses existing success/warning/danger tokens。Feature/Desktop CSS cannot redefine colors by
Theme Pack ID。

## Motion And Reduced Motion

- chrome opacity：`120ms fast`；
- Menu：shared Menu transition；
- status change：direct/fast fade；
- no bounce、shake、scale or continuous decoration；
- reduced motion removes translate and spinner rotation fallback follows Spinner contract。

## Platform Rules

- macOS/Windows share component geometry and semantics；
- client adapter owns native shadow、corner availability and transparency fallback；
- Windows high contrast uses system colors；macOS reduced transparency uses solid surface；
- component never checks `process.platform`。

## Acceptance

- components render in `ling-light`、`ling-dark` and custom Theme Pack fixture；
- all IconButton hit areas are at least `32px`；
- hover-hidden controls remain keyboard reachable；
- status detail and recovery action do not overlap at `320px` width；
- no component imports Electron、daemon、API Client or Computer Use contracts；
- Desktop PiP and main-window capability control use these primitives instead of private button/menu CSS。
