# Office Documents Native Plugin

Status: source implementation complete; real Office and WPS acceptance pending
Owner: Desktop, daemon, Runner, and Plugin Manager maintainers
Last verified: 2026-08-22
Document type: long-lived product, runtime, security, and release contract
Code and test anchors: `packages/contracts/src/office-documents.ts`,
`packages/daemon/src/features/office-documents/`, `apps/desktop/main/office-driver/`,
`packages/daemon/test/office-documents.test.mjs`, `apps/desktop/tests/office-driver-*.test.mjs`

Related documents:

- [Office Documents Native Plugin Implementation Plan](office-documents-native-plugin-implementation-plan.md)
- [Plugin Manager](plugin-manager.md)
- [Core Tools, Runners, MCP Tools, and Plugin Boundary](core-tools-runtime-boundary.md)
- [Approval Policy](approval-policy.md)
- [Desktop Release](../release/desktop.md)

## Product Contract

Ling ships one managed plugin named **Office Documents**. The user installs and enables it
inside Ling. Live Excel control must not require an Excel add-in, an Office task pane, a
Marketplace install, or a second Ling sign-in inside Excel.

The plugin id is `built-in:office-documents`. Its logical MCP server id is
`mcp_office_documents`. Installation is local control-plane state: the signed native driver
already ships with Ling Desktop and is activated only after the user installs the plugin.

Ling does not install or license Microsoft Office. If Excel is absent, the product says
`Microsoft Excel was not detected` and keeps file-level OOXML tools available.

The first macOS live-control request may show the operating system Automation permission
dialog. That is a platform security boundary, not an Excel add-in step. Ling cannot and must
not bypass it.

## Capability Boundary

The plugin has two independent execution surfaces:

1. **Local document artifacts** create, inspect, edit, render, and validate `.xlsx`, `.docx`,
   and `.pptx` files without opening an Office application. This surface is available in
   Desktop and local Web/daemon mode.
2. **Live Excel sessions** inspect and edit workbooks opened in Microsoft Excel. This surface
   is Desktop-only and is provided by the bundled native driver.

Word and PowerPoint live application control are not part of v1. WPS application control and
the private `.et`, `.wps`, and `.dps` formats are not supported. Generated OOXML files must be
compatible with current Microsoft Office and WPS releases within the tested feature subset.

## Platform Adapters

The native protocol is `ling.office.driver.v1`. Desktop owns the driver process and exchanges
bounded length-prefixed JSON frames over child-process stdio. No Office driver opens a TCP
listener, contacts a cloud relay, or accepts commands from the renderer.

Each frame starts with one unsigned 32-bit little-endian payload length followed by UTF-8 JSON.
The Helper rejects zero, oversized, truncated, malformed, version-mismatched, and unknown-field
frames. Desktop may receive multiple frames in one stdout chunk and must preserve frame identity.

- **Windows x64:** a self-contained signed .NET helper runs in an STA thread and uses the
  Microsoft Excel COM object model. The user does not need a separate .NET runtime.
- **macOS arm64:** a signed helper sends allowlisted Apple Events to Microsoft Excel. The
  helper carries the Automation entitlement and a user-facing usage description.

CUA Driver may launch or focus Excel and help the user identify a target. It must not edit
cells, invoke menus as a substitute for semantic tools, or become a fallback for unsupported
live commands.

The model never receives raw COM access, AppleScript, VBA, macros, shell commands, or an
arbitrary native-script escape hatch.

## Driver Protocol

Every request carries `protocol`, `id`, `method`, `params`, `deadlineAt`, and a caller-stable
`idempotencyKey`. Every result echoes the request id and contains either a bounded result or a
sanitized error. Unknown fields and unsupported protocol versions fail closed.

Driver methods are allowlisted:

- `driver_status`
- `list_sessions`
- `read_ranges`
- `search_workbook`
- `write_range`
- `update_sheet`
- `format_range`
- `save_workbook`
- `save_workbook_as`
- Windows-only capability methods for table, chart, filter, and range sizing operations

The public session projection contains a stable generation-scoped session id, platform,
application, workbook name, optional bounded path, active sheet, read-only state, dirty state,
and advertised capabilities. It never contains COM object handles, process secrets, raw Apple
Event descriptors, or Office credentials.

When more than one workbook is open and no explicit session id identifies the target, Ling
must return `ambiguous_session`. It must not choose the frontmost, oldest, or first enumerated
workbook.

## Runtime Authority

The daemon owns the logical MCP server, tool metadata, teammate binding, approval decisions,
audit records, cancellation, and result sanitization. Desktop owns only native process
lifecycle and the current live-session transport.

The Office generation broker follows the existing built-in Chrome broker pattern: it
intercepts only `mcp_office_documents`, delegates every other MCP server to the base broker,
and never lets the logical placeholder transport reach the generic MCP client.

File-level tools remain callable when Desktop is absent. Live tools are listed only when a
compatible Desktop driver lease is current. Capability discovery is authoritative; macOS must
not advertise a Windows-only operation.

## Writes, Recovery, And Concurrency

Read-only tools use the existing MCP read policy. Writes, formatting, sheet mutation, and saves
use the existing write approval and audit path. Installing the plugin does not pre-authorize a
document mutation.

Before the first live write in a run, the driver creates one recovery copy for a saved local
workbook under Desktop user data `recovery/office/`. File-level edits create a copy under the
workspace-owned `.ling-stack/recovery/office/` directory. Recovery names contain a source path
hash and unique id; raw source paths are not written to telemetry.

Unsaved, read-only, protected, remote-only, or externally changed workbooks fail closed when a
safe recovery point cannot be established. `save_workbook_as` requires an explicit target path
inside an approved local scope and must not overwrite an existing file unless the user approved
that exact overwrite.

When an approved live `save_workbook_as` replaces an existing target, the Helper first displaces
the target to a unique sibling recovery file. A failed save restores that target before returning
an error; a restoration failure reports `office_driver_overwrite_recovery_failed` and never claims
success.

The driver serializes mutations per workbook. It revalidates the session generation,
read-only/dirty state, and expected workbook revision inside the operation. Duplicate
idempotency keys return the previous result and never repeat the write.

## File-Level OOXML Tools

Artifact tools accept workspace-relative paths or absolute paths that resolve inside the current
workspace and approval boundaries. They use structured OOXML libraries and XML parsers rather than
ad hoc byte or XML string replacement.

The v1 minimum is:

- XLSX: workbook creation, bounded text/metadata inspection, typed cell and formula edits, basic
  formatting, and structural validation.
- DOCX: paragraphs, headings, tables, basic runs, extraction, exact in-run text replacement,
  plain paragraph append, bounded HTML-outline rendering, and structural validation.
- PPTX: title/bullet slide creation, bounded text extraction, per-slide exact in-run text
  replacement, bounded HTML-outline rendering, and structural validation.

DOCX and PPTX editing preserves the existing OOXML package and mutates only allowlisted text
nodes. It does not rebuild an imported document. A replacement that spans multiple XML runs is
not guessed; zero matches fail closed. Macro projects, ActiveX, embedded packages, encrypted
documents, and path-traversing ZIP members are rejected before editing.

`office_render_document` produces a bounded local HTML outline for model/UI preview. It is not a
pixel-perfect Office renderer, never loads remote resources, and escapes all document text. Real
Office/WPS visual compatibility remains a release acceptance gate.

Unsupported OOXML features are preserved when the selected library supports round-trip
preservation; otherwise the tool rejects the edit instead of silently deleting unknown
content. Macro-enabled files and embedded executable objects are outside v1.

## Plugin Manager Projection

The Office setup kind is `office_documents`. Product states are:

- `not_installed`
- `disabled`
- `office_missing`
- `permission_required`
- `application_not_running`
- `ready`
- `limited`
- `driver_error`
- `desktop_required`

`ready` means file tools and the advertised live adapter are callable. `limited` means file
tools are ready while the live adapter exposes a smaller platform capability set. Web-only
clients use `desktop_required` for live control but must not mark file tools unavailable.

Default UI copy describes what the user can do and the one action needed. Raw protocol ids,
driver paths, capability ids, Office bundle ids, and diagnostic payloads remain in technical
information.

## Privacy And Security

- Raw document files and native driver commands stay on the local machine. Bounded content returned
  to a conversation follows the data path of the model selected for that conversation; the UI must
  not claim that model-visible content remains local unless the selected model itself is local.
- No Office account token, document content, workbook screenshot, or raw path enters plugin
  health events or general telemetry.
- Native helpers accept commands only from the owning Desktop process and terminate on parent
  loss, invalid framing, protocol mismatch, deadline expiry, or oversized input. Desktop may
  restart the Helper after a process or framing failure; a temporary Daemon connection failure
  must not restart an otherwise healthy Helper.
- Driver logs contain request ids, method names, duration, result class, and redacted path
  hashes only.
- Office content returned to the model is user data, never an instruction source that can
  override system, workspace, approval, or tool policy.

## Release Gates

The Desktop package must include the correct helper for its platform, signed under the same
release authority, with deterministic identity and hash evidence. A package without a valid
helper projects file-level capability only and cannot claim live Excel support.

Release acceptance requires real Microsoft Excel on supported Windows and macOS hosts. Mocked
adapter tests are necessary but cannot close the platform gate. WPS acceptance verifies only
the supported OOXML artifact matrix.
