# Full-Window Theme Background Research（历史）

Status: source-audited proposal; implementation and runtime verification pending
Owner: theme and presentation delivery track
Last verified: 2026-10-19 after fetching and fast-forwarding to
`origin/main@912e3e8e835f68a0d62161e3d5694ce9f9f7c6cb`, with theme WIP preserved;
the original source audit remains historical at `708931ac` on 2026-10-18
Document type: research and implementation guidance
Superseded by: [official scene theme and custom media background implementation plan](full-window-theme-background-implementation-plan.md);
dynamic media is now specified by the current contract, not by this research note

## Goal And Boundary

Ling should support one continuous local image or video behind the entire desktop
workspace. The left navigation, conversation area, right dock, and expanded panels
must reveal the same frame instead of rendering independent backgrounds. A separate
sidebar image can remain a later option, not the default architecture.

This report records source evidence and a proposed delivery path. It does not claim
that static or dynamic backgrounds currently work, and it adds no runtime code.

The subsequent [unified theme, background and motion contract](theme-background-motion-contract.md)
owns the accepted design and local interaction pilots. Those pilots do not implement
the full-window media path described here.
The [P2 plan](full-window-theme-background-implementation-plan.md) and
[acceptance matrix](full-window-theme-background-acceptance-matrix.md) now define the
static-image implementation, task order, and separate Web/Desktop gates. No P2 runtime
verification is claimed.

## Current Capability

- `ThemeRegistry` already validates, installs, selects, previews, persists, reimports,
  deletes, and falls back between theme packages. Web uses IndexedDB; Desktop uses the
  native theme repository, typed IPC, atomic publication, recovery, and first-paint
  bootstrap.
- Built-in themes are `ling-light` and `ling-dark`. System mode is a selection strategy,
  not a separate theme package.
- Current packages are token-oriented. The Web quick-theme compiler, package parser,
  and Desktop installed-theme reader reject runtime artwork.
- Artwork slots and presentation profiles such as `shell-background`, `ling-glass`,
  `ling-immersive`, and `ling-illustrated` are contracts or preview concepts. They are
  not a complete AppShell image/video rendering path.
- AppShell panels currently paint opaque surfaces. A background layer placed below the
  shell would remain hidden until those surfaces use background-aware materials.
- Main now includes a product-owned native image sanitizer and Desktop resource packaging.
  P2 reuses its byte codec through a host-owned adapter with stricter background limits;
  the daemon execution-engine artifact adapter is not the user-background repository.
  Native execution selection and blocked/error states also require preservation during
  theme/background changes. These integration details are owned by the P2 plan.

## Proposed Architecture

Use one persistent media layer outside AppShell and below all workspace surfaces. Theme
tokens continue to own colors and contrast; a presentation profile controls panel
opacity, blur, scrim, and focus treatment. Navigation must not recreate or restart the
media element.

Static images should land first. The accepted P2 path is a separately selected local
user image in an independent background repository and preference, with atomic
publication and failure preservation. It does not add artwork to imported Theme Packs:
the existing D1=A token-only import boundary and Quick D3=A remain in force. The P2 plan
supersedes this research's earlier suggestion to carry background resources in theme
manifests. Theme changes retain the user's image; scrims and materials follow semantic
colors. Package artwork requires a later explicit contract change.

Dynamic artwork should extend the same layer with local MP4/WebM playback: muted loop,
hidden-window pause, reduced-motion and playback-failure poster fallback, explicit
object-URL/player cleanup, and restart restoration. A single player prevents panel
desynchronization and duplicate decoding.

## Safety And Compatibility

- Accept only declared image/video MIME types with size, dimension, duration, member
  path, and content-hash validation.
- Reject CSS, JavaScript, executables, traversal paths, remote URLs, and undeclared
  package members.
- Preserve readable contrast through semantic tokens and bounded scrims. Do not let a
  theme package change layout, icon meaning, permissions, business state, or behavior.
- Failed import, decode, playback, or missing-resource recovery must retain the last
  valid theme and expose a reset path.
- Respect reduced motion, hidden-window suspension, GPU/memory limits, and resource
  cleanup during switch, deletion, logout, and application exit.

## Delivery Order

1. Move remaining shell and panel colors to semantic theme variables and verify custom
   light/dark packages without artwork.
2. Add managed static full-window artwork, persisted settings, preview, reset, and
   failure rollback.
3. Add MP4/WebM to the same media layer with lifecycle, fallback, and resource-budget
   controls.
4. Add optional region-specific artwork only after the shared full-window path is
   stable; never create independent default players per panel.

## Acceptance Matrix

Verify image and video import, preview, apply, restart restoration, theme switching,
reset, reduced-motion fallback, hidden-window pause/resume, damaged or missing resource
rollback, and cleanup after replacement/deletion. Run the same user workflow in Web,
packaged macOS Desktop, and native Windows Desktop. Source checks, token inspection, or
a visible Web frame alone do not satisfy cross-platform acceptance.

External skin projects may inform configuration shape, media lifecycle, preview, and
recovery behavior. Their CDP injection, selector overrides, and external application
file modification must not be copied into Ling's React/Electron theme package model.
