# AI Teammate Custom Create Flow

## Related Docs

- [Ling Design System](ling-design-system.md)
- [AI Teammate Private Workspace](ai-teammate-private-workspace.md)
- [Ling UI 2.0 整体升级方案](./ui2.0升级/00-UI2.0整体升级方案.md)
- [Global Feedback Toast System](global-feedback-toast-system.md)

## Summary

The current `Start from blank` entry in the AI teammate create dialog only clears the
template selection and keeps the user in the same compact form. It does not feel like a
real custom teammate path, and creation closes the dialog immediately without showing
model verification, record creation, channel setup, memory readiness, or where a failure
stopped.

The custom teammate path should become a complete in-dialog flow:

1. Choose a role or enter custom setup.
2. Configure avatar, name, ready chat model, description, and optional channel.
3. Create and verify with visible step progress.
4. Close the dialog and open the created teammate once setup succeeds.

This is a Web frontend productization slice. It does not add daemon routes, contracts,
database fields, or a new teammate health-check API.

## Product Model

Custom teammate creation is not a template toggle. It is a focused setup flow for a
workspace actor:

- identity: uploaded avatar or avatar tone, display name, and short work brief;
- runtime: a ready chat model selected from Model Workbench;
- placement: optional first channel membership;
- readiness: step-by-step verification before the dialog closes.

The user should know whether the teammate is ready, partially created, or blocked before
they leave the dialog.

## Detailed Design

### Dialog Modes

The create dialog has three internal modes:

| Mode | Purpose | User-visible behavior |
| --- | --- | --- |
| `role_select` | Default quick-start path | Shows recommended templates plus `Start from blank`; template creation remains compact. |
| `custom_setup` | Custom teammate setup | Fills the dialog body; left-top back button returns to role selection. |
| `setup_progress` | Create and verify | Replaces fields with a progress checklist and success/failure actions. |

The dialog remains one modal. It should not open Settings, a new route, or a separate
drawer unless the user explicitly chooses `Model Workbench`.

### Custom Setup Page

Default visible fields:

- avatar preview with upload control and a small tone selector fallback;
- teammate name;
- base model selector containing only ready chat providers;
- short description / working brief;
- optional first channel;
- primary action `Create and verify`.

No advanced settings are shown in this flow. Skills, MCP, permissions, memory content,
and danger actions remain in the created teammate settings page.

If no ready chat model exists:

- show a compact blocked state;
- disable creation;
- show `Open Model Workbench`;
- do not show an empty model select as if creation can continue.

### Setup Progress

Progress steps:

1. `Workspace` - local workspace path is present.
2. `Model check` - run existing provider preflight for the selected model.
3. `Create teammate` - persist the teammate record.
4. `Upload avatar` - upload the selected avatar image after the teammate id exists;
   otherwise skipped.
5. `Join channel` - bind the first selected channel when present; otherwise skipped.
6. `Prepare memory` - read teammate memory scopes to confirm default scopes are present.
7. `Refresh workspace` - refresh teammate and channel surfaces.

Step states: `pending`, `running`, `success`, `failed`, and `skipped`.

Failure behavior:

- Model check failure stops before teammate creation.
- Record creation failure stops with no teammate created.
- Avatar, channel, or memory failure keeps the created teammate and marks setup as
  partial.
- Partial success shows `Open teammate settings` and `Retry setup`.
- Full success closes the dialog automatically and opens the teammate private
  workspace. The user does not need to click a second confirmation after the last
  successful step.

### Copy Rules

- Use product copy such as `Model check failed. Repair this model in Model Workbench.`
- Raw provider messages can appear in a folded detail or small secondary line, not as the
  main failure title.
- Success says the teammate is ready to use from the workspace, not merely "saved".

## API And State

Reuse existing frontend APIs:

- `checkProvider(cwd, providerId)`
- `createAiTeammate(cwd, input)`
- `uploadTeammateAvatar(cwd, teammateId, file)`
- `replaceTeammateChannels(cwd, teammateId, memberships)`
- `listTeammateMemoryScopes(cwd, teammateId)`
- `listAiTeammates(cwd)`

Frontend-only additions:

- `TeammateCreateMode`
- `TeammateCreateSetupStep`
- `TeammateCreateStepState`
- `TeammateCreateProgressEvent`
- optional `avatarTone` on `LocalTeammateCreateInput`
- optional `avatarFile` on `LocalTeammateCreateInput`

The shared create shell stays presentational. It should not import teammate domain logic.

## Acceptance Criteria

- Clicking `Start from blank` opens a full custom setup page inside the same dialog.
- The custom setup page has a working back button.
- Creation does not close the dialog while setup is running.
- A user can see which setup step is running, succeeded, failed, or skipped.
- Custom setup can select an avatar image and preview it before creation.
- Model check failure does not create a teammate.
- Successful creation closes the dialog automatically, opens the new private teammate
  workspace, and the teammate appears in the left sidebar, Settings teammate
  management, and channel teammate pickers.
- Partial setup keeps the teammate and gives repair actions.
- No "Advanced settings" controls are visible in the create dialog.
- Dark mode has no visual overlap, clipped controls, or unreadable progress states.

## Assumptions

- Desktop Web is the acceptance target.
- Provider preflight may be a real model request or static check depending on provider
  type; this flow reports the result truthfully.
- A future teammate-specific self-test reply can be designed separately if needed.
