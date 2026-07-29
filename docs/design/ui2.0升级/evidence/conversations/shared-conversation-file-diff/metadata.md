# Shared Conversation File Diff

## Scope

T13-O.12 moves the shared FileChange and DiffViewer baseline from `components.css` into
`styles/shared/conversation-file-diff.css`. It preserves the four intentional WorkCell, Artifact hover and Workspace
Review adapters, stabilizes lazy preview requests, and restores the layout accidentally omitted when ArtifactRow was
previously moved into its focused owner. Diff parsing, collapse thresholds, API contracts and business state do not
change.

## Evidence

| File | Viewport / theme | Reachable state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-channel-message-diff.png` | 1440x960 / Ling Light | structured multi-hunk diff, fold marker, malformed fallback and deferred summary after keyboard collapse | `10b0f59af858c6b17adf0dc1e10be243dad84166ed6b35cf3ef7474f5b25bd74` |
| `1280x800-ling-dark-durable-work-cell-diff.png` | 1280x800 / Ling Dark / reduced motion | durable thread WorkCell, two-file inline preview, expanded ranges and long unbroken content | `66d1dd5e83a2d14c4a27ffecc3f7b8056864f65db4e1b9f25796b981238b7f03` |
| `1440x960-ling-light-runs-preview-failure.png` | 1440x960 / Ling Light | lazy FileChange preview failure, stable alert and restored ArtifactRow layout with non-overlapping actions | `49c586d510bdb15c6c8cd39b6b83208f6ef88602e34cd6a1d41dfe32684b394c` |
| `1280x800-ling-dark-normal-workspace-review.png` | 1280x800 / Ling Dark / reduced motion | Normal Details Review, changed-file navigator/filter, long selected diff and Workspace override | `1c8cf6d13f26fe73aa34e8e42b4cb3fef60eb26bea081289e120ef118f20ef5d` |

All four images were inspected at original size. Diff lines, paths, controls and overlays remain inside their owners.
The first Runs capture exposed overlapping ArtifactRow content; the focused owner was repaired and the listed image is
the successful recapture with title, size and actions separated.

## Verification

- focused capture and repeat: `ui2-conversation-file-diff.spec.ts` `4/4`;
- selected integration: Runs/Threads, Runtime, Approvals, External Work, Channel Settings Overlay Dock, Normal Dock and
  Teammate Dock `49/49`;
- existing Channel structured diff, Workspace Review, demo WorkCell and durable WorkCell `4/4` before the combined run;
- FileChange failure remains visible with exactly one preview request per open attempt;
- ArtifactRow direct-child geometry has no overlap in the Runs failure state;
- Web `check:i18n`, lint, typecheck, production build and `git diff --check` passed;
- focused file-diff and ArtifactRow owners have zero color literals, `!important`, Theme selectors, `transition: all`,
  private keyframes, literal z-index and package-private `.ling-ui-*` selectors;
- `components.css` shared file-diff roots are zero; four intentional adapter overrides remain registered.

## Result

`components.css` is 7,584 lines, the file-diff owner is 256 lines and the ArtifactRow owner is 120 lines. The Web CSS
tree is 148 files / 38,740 lines. No Function ID, API, contract, diff parser, threshold, package export or packaged
Desktop status changed. `ConversationWorkCell.tsx` remains 1,025-line architecture debt; its unrendered
loading/error/truncated states are a later extraction task, not hidden as complete here.
