# Global Feedback Toast System

## Related Docs

- [Ling Design System](ling-design-system.md)
- [Settings Profile Identity Redesign](settings-profile-identity-redesign.md)
- [Settings Visual Density Follow-up](settings-visual-density-followup.md)
- [Settings Full-Surface Productization P10](settings-full-surface-productization-p10.md)

## Summary

Ling needs one global transient feedback pattern. Several surfaces currently render
small success or action messages directly inside the page, so the layout shifts, the
visual language differs by feature, and lightweight confirmations compete with the
actual task surface.

The chosen direction is the second GPT image reference: a **premium top-center
porcelain toast**. It should feel like a native command-palette notification:
quiet, precise, slightly dimensional, and productized. It must be more polished than
a plain white pill, but still restrained enough for Ling's local-first AI workspace.

This design only covers transient action feedback. Blocking errors, destructive
warnings, validation messages, readiness blockers, approval states, and diagnostics
must remain near the object they affect.

## Product Goals

- Give save/copy/apply/created feedback a consistent, polished surface.
- Remove page-level success chips that sit under forms or avatar blocks.
- Stop one-off `alert()` calls and feature-specific toast styling.
- Keep important repair information persistent and contextual.
- Make Chinese and English feedback follow the same semantic rules.

## Feedback Taxonomy

| Feedback type | Use global toast? | Default location | Examples |
| --- | --- | --- | --- |
| Lightweight success | Yes | Top-center toast | `个人资料已保存`, `Profile saved`, `Copied`, `Skill governance policy saved` |
| Lightweight info | Yes | Top-center toast | `Goal paused`, `Source unavailable`, `Saved view limit reached` |
| Non-blocking warning | Sometimes | Toast plus optional inline context | `Saved, but check failed` when the form still shows the repair path |
| Blocking error | No, not as the only message | Inline alert near the failed object | Missing API key, daemon unavailable, failed provider check, invalid workflow |
| Field validation | No | Under or beside the field | Required name, invalid URL, invalid token format |
| Destructive warning | No | Confirmation dialog or danger zone | Delete channel, delete branch, revoke token |
| Long-running progress | No | Button/loading row/status area | Generating, checking provider, running diagnostics |
| Diagnostic evidence | No | Details, inspector, or diagnostics panel | raw ids, paths, hashes, event logs |
| Notification inbox items | No | Popover/list/notification center | Channel governance notifications |

Rule of thumb: a toast is appropriate when the user does not need to keep reading it
to complete the next action. If the message contains the repair path, it should stay
in the page.

## Visual Direction

Name: `Ling Toast`

The toast should feel quietly premium:

- Surface: frosted porcelain neutral panel, not a bright colored pill.
- Shape: 10-12px radius, compact rectangle, no oversized capsule.
- Border: 1px hairline using theme border tokens.
- Highlight: a very subtle top or inset highlight to create native-app depth.
- Shadow: soft ambient shadow; no heavy floating card shadow.
- Accent: a small status bead with icon, never a full green background.
- Typography: 14px, medium weight, no secondary description by default.
- Layout: icon bead and text vertically centered on one line.
- Motion: soft slide-down plus fade-in; fade-out plus slight drop.
- Reduced motion: fade only.

Reference dimensions:

- Min height: 44px.
- Preferred height: 48-52px.
- Width: content-based, clamped around 220-320px.
- Horizontal padding: 14-16px.
- Gap: 10-12px between status bead and text.
- Top offset: 18-24px from the app viewport, adjusted below modal chrome if needed.

## Tones

All tones share the same neutral surface. Tone only changes the status bead and
optional hairline accent.

| Tone | Accent | Duration | Role |
| --- | --- | --- | --- |
| `success` | Soft green check bead | 3000ms | `status`, polite |
| `info` | Neutral blue or slate info bead | 3000ms | `status`, polite |
| `warning` | Amber dot or alert bead | 5000ms | `status`, polite |
| `error` | Soft red alert bead | 6000ms for lightweight errors only | `alert`, assertive |
| `loading` | Subtle spinner bead | Until updated or dismissed by caller | `status`, polite |

Blocking errors should not rely on a disappearing `error` toast. The toast may say
`Save failed`, but the inline surface must still show what to fix.

## Interaction Rules

- Toasts stack top-center with the newest item closest to the top.
- Maximum visible toasts: 3. Additional toasts queue or replace by scope.
- Repeated success from the same scope should replace the previous toast instead of
  stacking.
- Hover or focus pauses auto-dismiss.
- Escape dismisses the focused toast.
- A toast may include one short action only when the action is directly related, for
  example `View details`. P1 can ship without action buttons.
- Toasts should not move page layout.
- Toasts should not cover active dialogs. If a dialog owns the action, the toast
  anchors inside the app viewport above the dialog stack only when it remains readable;
  otherwise the dialog should use inline feedback.

## Component Contract

Create one shared feedback layer, not feature-specific variants.

Suggested module boundary:

- `apps/web/src/shared/feedback/LingToastProvider.tsx`
- `apps/web/src/shared/feedback/LingToastViewport.tsx`
- `apps/web/src/shared/feedback/useLingToast.ts`
- `apps/web/src/shared/feedback/types.ts`
- `apps/web/src/styles/global-toast.css`

Type shape:

```ts
export type LingToastTone = "success" | "info" | "warning" | "error" | "loading";

export interface LingToastInput {
  readonly id?: string;
  readonly scope?: string;
  readonly tone: LingToastTone;
  readonly message: string;
  readonly durationMs?: number;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}
```

Rules:

- The provider owns timing, stacking, reduced-motion behavior, and dedupe.
- Feature code only calls `showToast(...)`; it does not manage timeout CSS itself.
- i18n stays in feature code before calling the toast. The toast component receives
  already-localized text.
- The shared toast component does not import Settings, profile, workspace, provider,
  plugin, or skill domain modules.
- Existing inline alert components remain presentational and separate.

## Migration Inventory

This is the first-pass inventory from the current web code. Implementation should
verify each surface live before migrating.

| Surface | Current pattern | Target |
| --- | --- | --- |
| Settings Profile | `.profile-settings-tip` inside the profile page | Replace save/saving/error toast with `LingToast`; keep field/crop validation inline |
| Settings Personalization | `.settings-inline-tip` | Save success uses `LingToast`; policy or validation copy stays inline |
| Skill Governance | `.settings-inline-success` | Save success uses `LingToast`; disabled daemon/version blocker stays inline |
| Plugin Manager | `.settings-plugin-action-notice` | Install/enable/apply/check completion uses `LingToast`; runtime preview remains inline details |
| Provider / Model Workbench | `.provider-batch-result` and save messages | Single preset save success uses `LingToast`; batch failures and repair guidance stay inline |
| Channel settings | `.inline-success.compact` after settings actions | Save success uses `LingToast`; autosave state remains inline because it describes current form state |
| Channel inspector | `.inline-success.compact` for inspector actions | Lightweight success uses `LingToast`; object-specific warnings remain in inspector |
| Workspace composer | `composerFeedback` rows | Keep contextual composer blockers inline; consider moving copy/sent success to toast or silent feedback in a later slice |
| Conversation block actions | `.conversation-block-feedback` and menu feedback | Copy/expand success can use `LingToast`; unavailable/copy failure remains contextual when focus matters |
| Conversation background work | `.conversation-background-toast` | Align visual style with `LingToast` or route through provider if it is not tied to feed position |
| Artifact preview drawer | `artifact-preview-action-feedback` | Copy/download success can use `LingToast`; preview unavailable stays inside drawer |
| MCP tools | `.mcp-server-feedback` | Row check/save result stays row-scoped when it affects one server; global success only for page-level actions |
| Saved views limit | `globalThis.alert(...)` | Replace browser alert with `LingToast` warning |

## What Must Not Migrate

Keep these visible in the page:

- API key missing and provider-auth repair instructions.
- Scheduler stopped or daemon readiness blockers.
- Source sync health findings and review queue evidence.
- Startup diagnostics blockers and run diagnostics status.
- Approval waiting banners.
- Destructive restore/delete rules and confirmation copy.
- Any message that tells the user exactly which field or object is wrong.

## Dark Mode

Dark mode should use the same structure:

- Neutral elevated surface from theme tokens.
- Hairline border with enough contrast.
- Accent bead remains local and small.
- Shadow is softer and less black than the current modal shadow.
- Text contrast must meet normal body text expectations.
- No hard-coded white, black, or saturated green panel backgrounds.

## Accessibility

- `success`, `info`, and `warning` use `role="status"` with `aria-live="polite"`.
- Lightweight `error` uses `role="alert"` with `aria-live="assertive"`.
- Each toast has a stable dismiss button with an accessible label when dismissible.
- Focus should not be stolen when a toast appears.
- Keyboard users can tab to a toast action or dismiss control only if the toast has
  an action or explicit close button.
- Reduced-motion users get opacity-only transitions.

## Acceptance Criteria

- `Profile saved` / `个人资料已保存` uses the new global toast, not an inline page chip.
- At least Settings profile, personalization, skill governance, plugin action notices,
  and provider save success share the same visual toast component.
- No feature defines a new one-off top-center toast style after the shared component
  exists.
- Browser `alert()` is not used for lightweight product feedback.
- Blocking repair messages remain visible in context after the toast disappears.
- Toasts do not shift layout and do not overlap the main active form controls at
  `1440x960` and `1280x800`.
- Light and dark themes both use theme tokens and avoid saturated success panels.
- Chinese and English messages stay semantically aligned.

## Implementation Order

1. Add shared toast provider, viewport, hook, types, and focused CSS.
2. Mount provider once near the web app shell root.
3. Migrate Settings Profile first because it already uses the target behavior.
4. Migrate Settings personalization, skill governance, plugin action notices, and
   provider save success.
5. Replace `globalThis.alert` lightweight warnings.
6. Review workspace composer and conversation feedback separately so contextual
   blockers do not become detached global messages.

## Assumptions

- This is a frontend-only productization slice.
- No daemon API, contracts, database, or route changes are needed.
- The generated visual reference is guidance only; no generated image asset should be
  shipped in the app.
- Desktop web remains the acceptance target.
