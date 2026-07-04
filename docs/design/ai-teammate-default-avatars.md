# AI Teammate Default Avatars

## Summary

AI teammates use product-built default image avatars when the user has not uploaded a custom avatar. These defaults are static PNG assets shipped by the web app. They are not user data, are not stored in `avatarImageAttachmentId`, and do not require backend migration.

This keeps the teammate list, private chat header, channel teammate rows, and council member rows visually complete while preserving the existing upload/remove avatar behavior.

## Asset Contract

- Runtime assets live under `apps/web/public/avatars/teammates/`.
- Each asset is a `256x256` PNG exported from a vector source.
- The visual style is a circular badge with transparent corners, a light surface, a soft outline, and one centered product symbol.
- The assets are intentionally non-human and non-cartoon. They are role badges, not portraits.
- The app references assets by stable public paths such as `/avatars/teammates/engineer.png`.

Required files:

| File | Role | Visual cue |
| --- | --- | --- |
| `ling-agent.png` | Ling Agent | central star/node motif, violet |
| `product-strategist.png` | Product Strategist | target/compass motif, orange |
| `architect.png` | Architect | blueprint/block motif, teal |
| `engineer.png` | Engineer | terminal/code motif, teal |
| `designer.png` | Designer | pen tool motif, violet |
| `qa.png` | QA | check badge motif, blue |
| `security.png` | Security | shield motif, rose |
| `release.png` | Release | package/check motif, orange |
| `docs.png` | Docs | document motif, gray-violet |
| `custom.png` | Custom/unknown | neutral sparkle/node motif, gray |

## Selection Rules

The avatar renderer must resolve a teammate avatar in this priority order:

1. If `avatarImageAttachmentId` exists, show the uploaded avatar by using the existing attachment content URL.
2. Else if `systemRole === "ling_agent"`, show `/avatars/teammates/ling-agent.png`.
3. Else if `templateId` matches a built-in template, show the mapped default image.
4. Else if `roleKey` matches a known role, show the mapped default image.
5. Else show `/avatars/teammates/custom.png`.
6. Only if the selected image fails to load, fall back to the existing initials avatar.

Deleting an uploaded avatar clears `avatarImageAttachmentId` and automatically reveals the built-in default image again. The default image path must not be written back to the teammate profile.

## Role Mapping

| Input | Asset |
| --- | --- |
| `systemRole: "ling_agent"` | `ling-agent.png` |
| `templateId: "ling_agent"` | `ling-agent.png` |
| `templateId: "product-strategist"` | `product-strategist.png` |
| `templateId: "architect"` | `architect.png` |
| `templateId: "engineer"` | `engineer.png` |
| `templateId: "designer"` | `designer.png` |
| `templateId: "qa"` | `qa.png` |
| `templateId: "security"` | `security.png` |
| `templateId: "release"` | `release.png` |
| `templateId: "docs"` | `docs.png` |
| `roleKey: "product"` | `product-strategist.png` |
| `roleKey: "architect"` | `architect.png` |
| `roleKey: "engineer"` | `engineer.png` |
| `roleKey: "designer"` | `designer.png` |
| `roleKey: "qa"` | `qa.png` |
| `roleKey: "security"` | `security.png` |
| `roleKey: "release"` | `release.png` |
| `roleKey: "docs"` | `docs.png` |
| `roleKey: "custom"` or unknown | `custom.png` |

## Implementation Boundary

- Frontend only: static assets, avatar display helper, shared avatar component, and tests.
- No backend API changes.
- No database or local store migration.
- No default avatar attachment records.
- No avatar editor.
- No runtime CSS drawing as the primary visual. CSS can size, clip, and theme the image container, but the badge itself is an image.

## Test Checklist

- Typecheck passes for `@ling-stack/web`.
- `git diff --check` passes.
- Built-in teammates with no uploaded avatar show `.teammate-avatar-image-default`.
- Uploaded avatars continue to win over default avatars.
- Removing an uploaded avatar returns the teammate to `.teammate-avatar-image-default`.
- The same default image appears consistently in:
  - global sidebar teammate rows,
  - AI teammates page rows,
  - private chat header,
  - channel teammate list/chips,
  - channel message teammate avatars,
  - AI council member rows.
- If a default PNG fails to load, the initials fallback remains visible.
- Dark mode keeps the image edge soft and readable.

## Review Checklist

- All ten required PNG files exist under `apps/web/public/avatars/teammates/`.
- Default avatar lookup is centralized in one helper.
- `TeammateAvatarView` remains the only shared rendering path for AI teammate avatars.
- No implementation writes default avatar paths into `avatarImageAttachmentId`.
- Existing user upload and remove flows still work.
- Large workspace or settings files are not expanded for this feature.
