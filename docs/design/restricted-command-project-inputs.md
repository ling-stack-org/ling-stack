# Restricted command project inputs

Status: implementation in progress; no packaged acceptance or merge claimed.

## Cause and authority

C01-R2 captured the explicit CLI and CSV, but not the CLI's `./ledger.js` import.
The native reader worked correctly; the accepted operation did not express a
project dependency scope. A source import is a dependency fact, not permission.
Do not append arbitrary discovered files to legacy `inputRefs`, mount origin,
copy a complete workspace, change failed history, or relax effect-unknown gates.

## Contract and Host compilation

- Existing plans without a scope retain explicit-file semantics.
- A command candidate may name `projectInputRoot: {path, sourceQuote}` only when
  the current user instruction explicitly names that directory for this operation.
  A prefix of a CLI path or a command argument is not a scope anchor: the root
  quote must also appear outside the command/invocation. Historical/model
  material cannot supply scope authority. This is not a model-provided grant.
- The Host validates that quote, normalized workspace-relative path and filesystem
  boundary, then compiles `commandInputScope.kind=node_module_closure_v1` with
  the root and current-user source refs into the accepted operation. The plan
  fingerprint and immutable Run snapshot cover it; dispatch revalidates both.
- `effectScope.readPaths` continues to enumerate direct inputs. The additional
  scope is narrowly for preparing this exact command's local Node source/module
  dependencies, not a new `read` tool grant or write/network/environment grant.
- Scope absence never enables automatic expansion. A known missing local module
  must fail preparation with `restricted_command_dependency_scope_required`,
  before spawning the command, rather than fail later as MODULE_NOT_FOUND.

## Capture and discovery

Use the existing native directory-FD reader for every copied byte, including
dependencies and package metadata. Capture direct inputs first. For scoped Node
commands, parse only captured JS/MJS/CJS source inputs inside the project root,
then recursively follow literal relative import/export/require references.
Capture relevant package.json files between each source and the authorized root
to preserve ESM/CommonJS interpretation, stopping at the nearest package boundary.
For `.js`, no package.json inside the authorized scope leaves a potentially
inherited unauthorized ancestor format; reject that open
boundary with `dependency_package_boundary_required`, rather than silently
change the module interpretation or read metadata outside the scope. `.mjs` and
`.cjs` have explicit formats. Copy only the discovered set, not every
file under that root. JSON modules are data, not parsed JavaScript.

All derived paths must remain inside the explicit root, use supported extensions,
and exclude hidden/protected directory components. Builtin modules need no copy.
Version1 supports exact relative JS/MJS/CJS/JSON specifiers, static imports and
re-exports, literal dynamic import and literal CommonJS require. Package names,
extension/directory searching and nonliteral import/require fail explicitly;
there is no installation, origin fallback or claimed full Node resolver.
The OS sandbox remains the final boundary for computed/obfuscated accesses that
static analysis cannot enumerate. Parser output is never itself authority.

Reuse the 256-file, 16MiB/file and 64MiB/command limits, plus a bounded source
parser.
Missing package-metadata probes also share a 2048-probe ceiling; absent files do
not consume captured-file slots but cannot create an unbounded directory walk.
Cycles/deduplication use the captured path map. Recheck cancellation,
policy/Attempt ownership at native async boundaries and before actual launch.
Preparation errors retain existing cleanup/not_started journal semantics.

Evidence for each derived file records kind/version, parent path and captured
parent SHA256, with scope-source item IDs. Do not pretend the user quoted each
derived filename. No SQLite table or historical repair is needed.

## Verification gates

1. RED/GREEN source binding: valid explicit root, fake/foreign/stale quote,
   command-path prefix, non-command scope, fingerprint/snapshot mutation.
2. Pure capture tests: ESM/CJS/JSON, transitive/cyclic/duplicate references,
   package metadata, out-of-root/hidden targets, unsupported resolution, limits,
   cancellation and source changes. An unscoped command cannot expand inputs.
3. Real native/Seatbelt fixture: CLI imports ledger and reads CSV, output is
   correct, dependency hashes/lineage are durable, origin/network remain denied;
   missing input, symlink/hardlink and launch/approval cancellation stay safe.
4. Independent review of final source and tests, then reviewed-input QA packaging.
5. New real C01 task with explicit project dependency scope, two required
   participants and full original two-new-file project. Existing R2 remains failed.

This closes the project-input gap only. Recovery/delegation/Office/H09 and the
rest of E6 remain in the total plan; source tests do not replace GUI acceptance.
