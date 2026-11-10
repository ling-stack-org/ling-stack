# Bundled GStack Client Contract

Status: approved source contract; implementation ready for independent review; package acceptance deferred
Owner: Skills and Desktop maintainers
Last verified: 2026-10-17 against Ling `cd7d9d83` and GStack `1.91.101.0`
Document type: product and architecture contract
Code and test anchors: `packages/core/src/bundled-skill-source.ts`, `packages/daemon/src/features/skills/packaged-runtime.ts`, `scripts/gstack/`, `apps/desktop/tests/packaged-gstack-resources.test.mjs`

## Scope

Ling ships a reviewed, complete GStack resource set with the desktop client so
the 57 upstream skills can be discovered and executed without a separate global
GStack installation. The bundle also includes the upstream TestSavant prompt
injection model, its packaged Node runtime, and the browser resources used by
GStack workflows.

This contract extends [GStack Skill Source Sync](gstack-skill-source-sync.md) and
[GStack Source Upgrade Lifecycle](gstack-source-upgrade-lifecycle.md). It does not
install or update a user's global GStack, Codex, Claude Code, hooks, credentials,
or browser profile.

The implementation queue is the
[implementation plan](gstack-bundled-client-upgrade-implementation-plan.md). The
[acceptance matrix](gstack-bundled-client-acceptance-matrix.md) separates source
readiness from package and real-workflow acceptance.

## Pinned Inputs

- Ling baseline: `cd7d9d83bf3b13ac3b8b68c99f343e51a01a6e56`.
- GStack repository: `https://github.com/garrytan/gstack`.
- GStack revision: `47d639abffa882b8cbb641d7d1dedf08ecada9ec`.
- GStack version: `1.91.101.0`.
- Inventory: exactly 57 upstream skill templates.
- TestSavant revision: `5bfc06f0b54950e6653f253eb7df1e3c9811b5cb`.
- TestSavant model: original FP32 ONNX weight, pinned by exact size and SHA-256.

All build inputs, generated resources, package metadata, and runtime bindings
must trace back to these immutable identities. A changed input creates a new
generation; it cannot silently inherit old evidence.

## Bundle Shape

The executable bundle contains:

- all 57 rendered GStack skill bodies and their referenced files;
- packaged Node and the reviewed native dependencies required by selected paths;
- the original TestSavant worker, model, tokenizer, and local Transformers/ONNX
  runtime;
- a package-owned Chromium component and GStack browser server;
- compiled CLI, PDF, diagram, CSO, and support resources admitted by the reviewed
  dependency and command inventories;
- manifests, checksums, provenance receipts, licenses, and third-party notices.

The repository does not commit the multi-gigabyte executable resource tree. The
Desktop build selects one immutable external bundle, authenticates it, copies it
through `extraResources`, embeds its identity in the daemon build, and rechecks
the original and copied bytes after packaging.

## Source Publication And Upgrade

On first use, the daemon verifies the package-owned bundle before publishing any
skill. Missing sources are published as one SQLite transaction; partial source
sets are never visible. Existing custom ownership, drafts, archived entries, and
explicit pins are preserved.

New bundled sources default to `follow`. A verified newer package may advance
them atomically. Users may pin the current generation, resume following, or roll
back to a retained generation. Stale expected snapshot/checksum values return a
conflict rather than overwriting newer state.

At most two authenticated generations are retained. Unknown writer state,
unexpected files, insufficient capacity, or a referenced generation that cannot
be retained stops the upgrade for review. The runtime never deletes a generation
that an existing task may still require.

## Execution Binding

Every prepared Pi execution freezes its complete skill source context and, for a
packaged GStack skill, a four-field resource binding:

- bundle manifest checksum;
- upstream revision;
- Ling adaptation revision;
- skill source checksum.

New and resumed runs must restore that exact generation. Missing, malformed,
mutated, or mismatched resources fail closed before model or command execution.
The command path derives `GSTACK_ROOT`, packaged tools, browser paths, TestSavant
paths, and an isolated per-run state directory from the authenticated binding.
It does not use a system Node installation or shared Playwright cache.

The GStack Host adapter may describe the existing structured-question tool to a
loaded, complete official GStack skill. It does not create a second answer UI,
grant approvals, or implement delegation. Public answer and recovery UI belongs
to the conversation experience contracts and must build on the single timeline
and composer ownership merged in PR #553.

## TestSavant

Ling uses the original TestSavant model expected by this GStack revision. Wolf is
not bundled, selected, or used as a replacement.

The worker:

- starts only from authenticated package resources;
- resolves only the packaged Node runtime;
- runs locally without first-run downloads, Python, or a model API;
- strips inherited authentication and preload/loader variables;
- processes a bounded queue with startup and scan deadlines;
- joins child exit, supports cancellation and idle release, and opens a circuit
  after repeated runtime failures;
- treats missing, corrupt, timed-out, malformed, or over-budget inference as
  unavailable, never as safe.

The fixed English/Chinese corpus records current model behavior, including false
positives. Model quality is an upstream model characteristic and does not block
source integration or bundling. It only limits the product claims Ling may make
about detection quality; results must not be hidden by threshold tuning or sample
relabeling.

Model and dependency notice review remains a release-evidence task. This source
PR carries immutable acquisition and packaging logic, not the model binary or a
public installer.

## Browser Runtime

GStack browser commands use the package-owned browser, server, FFmpeg, and an
isolated state root. Launch, navigation, interaction, snapshots, screenshots,
headed handoff, resume, and cleanup must use the selected resource generation.
No runtime download, quarantine, repair, or fallback to a shared Playwright cache
is allowed.

The browser candidate and its credits are authenticated independently from the
main zero-link resource tree. A browser failure makes browser-dependent workflows
unavailable without changing the frozen skill generation.

## Acceptance Boundary

The independent source PR is complete when:

1. Core and Daemon builds pass on the current Main baseline.
2. Source publication, follow/pin/rollback, frozen binding, retained-generation,
   TestSavant, browser-source, and Desktop packaging-source tests pass.
3. All 57 bodies and references match the pinned upstream revision.
4. Documentation, public-repository safety, and whitespace checks pass.
5. No answer/recovery UI, conversation timeline, unrelated model candidate, app
   package, release, or global installation change is included.

Mac and Windows installer generation, clean-machine installation, simulated
offline first launch, no-system-Node operation, damaged-resource recovery, and
all 57 real workflow scenarios are later release gates. Their absence does not
invalidate the source PR, but it prevents claiming that a distributable client
has passed final acceptance.

## Rollback

- Revert the source PR to remove bundled-resource activation code.
- Existing user skill snapshots and custom skills remain in workspace storage.
- A packaged client may roll back only to an authenticated retained generation.
- Never fall back from a frozen packaged task to metadata-only built-ins or the
  user's global GStack installation.
