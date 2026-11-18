# Ling Device Support Platform

Status: approved architecture baseline; implementation not started
Owner: Ling platform maintainers
Last verified: 2026-11-18
Document type: canonical product and technical design
Canonical replacement: none
Code and test anchors: `docs/architecture.md`, `apps/mobile/README.md`,
`packages/daemon`, `packages/core`, `packages/contracts`,
`packages/remote-protocol`, and `packages/runner-pi`

The delivery checklist is maintained in
[Ling Device Support Platform Implementation Plan](ling-device-support-platform-implementation-plan.md).

## 1. Purpose

Ling Device Support Platform lets a user use Ling Mobile or Ling PC to configure,
diagnose, repair, and understand external devices. A device can be a computer, a Home
Assistant installation, a router, a printer, a NAS, an Android device or head unit, a
vehicle interface, or another supported system.

The platform separates the language-model workflow from device-specific communication:

```text
Ling Mobile / Ling PC
        |
        v
Ling Gateway and daemon control plane
        |
        +-- task orchestration, policy, approvals, audit, recovery
        +-- model runner (Pi first, other runners later)
        |
        v
Unified device capability broker
        |
        +-- Home Assistant adapter
        +-- PC adapter
        +-- Android / head-unit adapter
        +-- OBD / OpenXC adapter
        +-- Matter / BLE / USB and vendor adapters
        |
        v
Protocol and transport implementations
        |
        v
External device or target-side executor
```

An adapter translates a stable Ling capability into a protocol-specific operation. The
model never needs to construct raw CAN frames, USB packets, arbitrary shell commands, or
vendor-specific payloads.

## 2. Product boundary

### 2.1 Goals

- Give a non-technical user one natural-language entry point for external device work.
- Reuse existing device ecosystems and protocols instead of rebuilding every driver.
- Expose typed, discoverable device capabilities to the model runner.
- Keep planning, permissions, execution, verification, and evidence separate.
- Support Ling Mobile and Ling PC through the same daemon-owned control plane.
- Allow a new device family to be added as an adapter without changing the core task
  model or client UI.
- Preserve local-first operation where the target and adapter can run locally.
- Record each operation as durable, reviewable evidence.

### 2.2 Non-goals

- Replacing operating-system drivers, vendor service tools, or Home Assistant
  integrations.
- Providing a universal protocol that can control devices with no exposed interface.
- Letting the model bypass vendor authentication, device locks, safety interlocks, or
  firmware signing.
- Exposing arbitrary remote shell or raw vehicle-bus writes as a default product tool.
- Claiming that a hardware failure can be repaired remotely.
- Supporting every model and firmware version in the first delivery slice.

## 3. Terminology

| Term | Meaning |
| --- | --- |
| Device | An external software or hardware system Ling can inspect or operate. |
| Device profile | Identity, vendor/model, firmware, transport, protocol, and support metadata for one device. |
| Capability | A typed operation or observation that a device exposes to Ling. |
| Adapter | A module that maps Ling capabilities to one device family or ecosystem. |
| Transport | The communication channel, such as HTTPS, SSH, WinRM, ADB, BLE, USB, MQTT, or CAN. |
| Target-side executor | A local service or hardware bridge needed when the target does not expose a usable remote API. |
| Playbook | A bounded diagnosis or repair workflow that combines observations and capabilities. |
| Evidence | Structured observations, action results, logs, and before/after state used to explain and verify work. |
| Remote Gateway | The daemon-facing remote boundary used by Mobile and future remote clients. |

`Device Agent` is not a required product term. A target-side component may be called a
Device Executor, Connector, or Hardware bridge depending on whether it runs software or
bridges hardware. It does not need to contain a language model.

## 4. Ownership and module boundaries

| Layer | Owns | Must not own |
| --- | --- | --- |
| Mobile, Web, Desktop, CLI clients | Conversation, device selection, approval UI, progress, and result rendering | Protocol details, target credentials, or direct database authority |
| Remote Gateway / daemon | Pairing, authenticated sessions, device tasks, routing, recovery, and remote API limits | A second conversation or run store owned by the client |
| `packages/core` | Device domain state, policy decisions, approvals, leases, and durable transitions | Adapter-specific protocol code |
| `packages/contracts` | Public DTOs, wire schemas, capability and task contracts | Crypto implementation, UI, storage, or model prompts |
| Model runner | Model turns, tool selection, planning, and explanation | Privileged device access or protocol encoding |
| Capability broker | Target resolution, capability snapshots, policy checks, action dispatch, verification coordination | Device-specific byte formats |
| Adapter SDK and adapters | Discovery, protocol translation, device observations, typed execution, and health checks | Product conversation state, model prompting, or unrestricted authority |
| Transport modules | Connection setup, framing, authentication handshakes, reconnect, and protocol I/O | User-facing diagnosis logic |
| Evidence and artifacts | Redacted durable records and before/after material | Unbounded secret storage or hidden side effects |

The current repository already has the first half of this split: the daemon is the local
authority, `packages/core` owns product state and policy, `packages/runner-pi` adapts
the Pi execution kernel, and the mobile app uses the Remote Gateway boundary. The current
mobile release remains a conversation client; device operations are a future capability
that must pass a separate security and acceptance review.

## 5. Proposed component layout

The first implementation should extend existing packages before creating a large package
tree. These names describe ownership; package extraction happens when a boundary has two
real consumers.

```text
packages/contracts/
  device-contracts.ts             # public DTOs and schema versions

packages/core/
  device-domain/                  # registry, profiles, task state, policy facts
  device-capabilities/            # normalized capability metadata

packages/daemon/
  features/device-support/        # broker, adapter lifecycle, task services
  features/remote-access/         # Mobile-facing device-task facade

packages/device-adapter-sdk/      # future package once an external adapter exists
packages/device-adapters/
  home-assistant/
  pc/
  android/
  vehicle/

apps/mobile/modules/
  device-transport/               # native USB/BLE bridges only when direct mobile I/O is needed
```

The first adapters may live under the daemon while their contracts stabilize. Adapters
must not import React, `apps/web`, `apps/mobile` screens, raw SQLite tables, or private
runner internals.

## 6. Device domain model

### 6.1 Device identity and profile

Each device has a stable Ling identity separate from its network address:

```text
DeviceIdentity
  id: stable Ling device id
  ownerScope: local user or workspace scope
  displayName: user-facing label
  kind: pc | home_assistant | router | printer | android | vehicle | other
  vendor, model, serialHint, firmwareVersion: optional normalized fields
  adapterId, adapterVersion
  transportRefs: redacted connection references
  status: online | offline | degraded | unknown | revoked
  lastSeenAt, lastCapabilitySnapshotId
```

Secrets, raw tokens, private keys, and passwords are stored through the existing secret
reference boundary. They are never part of a device profile, capability snapshot, prompt,
log, or artifact.

### 6.2 Capability descriptor

Every model-visible operation is described by a versioned capability:

```text
CapabilityDescriptor
  id: stable name, for example pc.collect_logs
  schemaVersion
  inputSchema, outputSchema
  sideEffect: read_only | reversible | mutating | irreversible
  approvalClass: allow | ask | deny_by_default | critical
  requiredPermissions
  prerequisites
  timeoutMs, idempotency
  verification: declared verification operation or result rule
  rollback: optional declared rollback operation
  support: device kinds, models, firmware ranges, adapter versions
```

The capability descriptor is the contract consumed by the model runner and policy
engine. An adapter may expose a capability only after it has verified that the target
supports it.

### 6.3 Observation and evidence

Observations are structured values with source, timestamp, freshness, and redaction
metadata. An action result references the observations used for planning and the
before/after state used for verification.

Evidence must distinguish:

- device-reported facts;
- adapter interpretation;
- model hypothesis;
- user-provided information;
- action output;
- verification result;
- missing or unverifiable data.

The model may explain an inference, but the UI must not present an inference as a device
fact.

## 7. Adapter contract

An adapter has a manifest and a runtime implementation.

### 7.1 Manifest

The manifest declares:

```text
adapterId, adapterVersion
supportedDeviceKinds
supportedTransports
requiredRuntime and platform
authentication methods
configuration schema
supported models and firmware ranges
capability catalog
health-check behavior
minimum Ling contract version
```

Unknown manifest fields and unsupported contract versions are rejected. A manifest is
metadata, not permission. Installing or enabling an adapter never grants a teammate an
action automatically.

### 7.2 Runtime operations

The stable runtime contract is intentionally small:

```text
health() -> AdapterHealth
discover(input) -> DeviceCandidate[]
connect(deviceRef) -> ConnectionHandle
getProfile(connection) -> DeviceProfile
getCapabilities(connection) -> CapabilityDescriptor[]
observe(connection, request) -> ObservationSet
execute(connection, action) -> ActionResult
verify(connection, verification) -> VerificationResult
cancel(connection, actionId) -> CancelResult
disconnect(connection)
```

`execute` accepts a capability id and validated input, not an arbitrary command string.
The adapter owns protocol encoding and maps protocol errors into stable error categories
with redacted diagnostic details.

### 7.3 In-process and external adapters

Use an in-process TypeScript adapter for a small, trusted, protocol-stable integration.
Use an external process over a versioned local JSON-RPC or HTTP boundary when the adapter:

- requires Python, Rust, Go, or a vendor SDK;
- needs a platform-specific driver;
- has higher crash or privilege risk;
- should be installed or updated independently.

The external process still uses the same manifest and capability contract. It does not
become an alternative model runtime.

### 7.4 Protocol and installation decision

The Ling capability contract is stable, but the physical protocol is selected by the
adapter. There is no single USB, Bluetooth, vehicle, or vendor protocol that can be
embedded once and control every device.

Use the least invasive deployment that the target supports:

| Target interface | Ling-side requirement | Target-side installation |
| --- | --- | --- |
| Home Assistant, router, NAS, printer, or vendor HTTPS/MQTT API | Matching adapter, credentials, and capability discovery | None when the target API is already enabled |
| Standard USB, BLE, Matter, or similar peripheral | Native transport bridge plus adapter | None when the device exposes the standard profile |
| PC or Android software diagnostics | Adapter plus a paired target-side executor, or an authorized SSH/ADB/WinRM API | Required when the platform does not expose the needed remote API |
| Vehicle or hardware without a network API | Authorized USB/BLE/OBD/CAN bridge and adapter | Bridge firmware or companion service may be required |

Once an adapter and protocol implementation pass their contract and support-matrix
checks, they are reusable across supported devices and Ling clients. Firmware changes,
vendor API changes, or new capability versions may require an adapter update; the device
profile records the adapter version and capability snapshot used by each task. Installing
an adapter is therefore a compatibility choice, not a grant of unrestricted device
control.

## 8. Model and tool boundary

The model sees normalized device tools, for example:

```text
device.list
device.describe
device.collect_diagnostics
device.read_status
device.propose_configuration
device.execute_action
device.verify_action
```

The model does not see raw adapter transport methods. A capability broker validates the
target, input schema, current device snapshot, policy, approval state, lease, and action
idempotency before dispatching an adapter call.

MCP may be used as a model-facing tool transport because Ling already has an MCP broker,
but MCP is not the device protocol. Device identity, capability versions, transport
authentication, approval, and recovery remain Ling-owned contracts.

Playbooks are separate from adapters. A Home Assistant adapter may support several
playbooks, and a playbook may call capabilities from more than one adapter when the
problem crosses a router, gateway, and end device.

## 9. Task lifecycle and recovery

Device work is a durable task, not a transient model message:

```text
created
  -> target_resolved
  -> capabilities_loaded
  -> planning
  -> awaiting_approval
  -> executing
  -> verifying
  -> succeeded | partial | failed | cancelled | unknown
```

Rules:

- A task stores the target device id, adapter version, capability snapshot, policy
  snapshot, input, and idempotency key.
- A reconnecting client reads durable state; it does not infer cancellation from a lost
  stream.
- An action may be retried only when the adapter declares it idempotent or the task has a
  safe retry policy.
- Verification is a separate step. An adapter returning without an error is not proof of
  a repaired device.
- Unknown outcomes are preserved when the transport fails after dispatch. The system
  must not automatically repeat a possibly mutating action.
- Cancellation is best effort and remains visible as a distinct result.

This reuses Ling's existing state-machine, lease, approval, artifact, and recovery model
instead of adding a second task lifecycle.

## 10. Security and permissions

### 10.1 Identity and pairing

- Mobile-to-gateway pairing reuses the existing secure-key and signed remote protocol
  boundary.
- Device adapters have independent target credentials and revocation state.
- Every device task records the initiating user, client, gateway, adapter, and device
  identity.
- A device can be revoked without deleting the rest of the workspace.

### 10.2 Action policy

Default policy is read-only. Mutating actions require a capability-specific decision:

```text
read_only       allow by default
reversible      ask or workspace policy
mutating        ask with explicit target and scope
irreversible    deny by default or require a dedicated approval profile
critical        separate product and safety review
```

Enabling an adapter or installing a playbook never changes approval policy by itself.
The run snapshot records the effective capabilities and decisions.

### 10.3 Secrets and data

- Store only secret references in profiles and configuration.
- Redact credentials, pairing material, vehicle identifiers, and private logs before model
  exposure and artifact persistence.
- Keep raw evidence local unless the user explicitly authorizes remote transfer.
- Do not send full device inventories or logs to a provider when a bounded excerpt is
  sufficient.

### 10.4 Physical and safety-sensitive devices

Vehicle actuation, locks, alarms, power equipment, and firmware writes require separate
capability classifications and explicit acceptance. Diagnostic read operations and
configuration operations must not be silently promoted to physical control.

## 11. Connectivity topologies

| Topology | Execution location | Typical use |
| --- | --- | --- |
| Local PC | Ling daemon and adapter on one computer | PC diagnostics, local Home Assistant, NAS and router APIs |
| Mobile remote | Mobile -> Remote Gateway -> daemon adapter | Phone as the user-facing control surface |
| Direct mobile | Mobile native USB/BLE/Matter bridge | Standard peripherals and small hardware bridges |
| Target-side executor | Remote Gateway -> service installed on target | Windows software repair, privileged system checks |
| Hardware bridge | Mobile/Remote Gateway -> OBD/CAN/BLE/USB module | Vehicle and devices without a network API |
| Cloud relay | Mobile -> relay -> user gateway | Deferred; requires a separate privacy and availability design |

Direct mobile transport code belongs in native modules and should expose the same device
capability contract. It must not contain separate diagnosis or policy logic.

## 12. Storage and API shape

Use existing workspace SQLite and artifact storage for the first implementation.

Durable domain records:

```text
DeviceRecord
DeviceConnection
DeviceAdapterInstallation
DeviceCapabilitySnapshot
DeviceTask
DeviceTaskTransition
DeviceObservation
DeviceActionAttempt
DeviceEvidenceRef
```

The first public API should be narrow and task-oriented:

```text
GET  /devices
POST /devices/pair
POST /devices/:id/revoke
GET  /devices/:id/capabilities
POST /device-tasks
GET  /device-tasks/:id
POST /device-tasks/:id/approve
POST /device-tasks/:id/cancel
GET  /device-tasks/:id/evidence
```

These are proposed boundaries, not current routes. The mobile facade must not expose the
general daemon router, arbitrary filesystem paths, provider secrets, or raw adapter
credentials.

## 13. Extension and compatibility strategy

### 13.1 Additive extension

Adding a device family should require only:

1. an adapter manifest;
2. an adapter implementation;
3. capability and error schemas;
4. a support matrix;
5. adapter contract tests and a simulator or fixture;
6. user-facing configuration and health copy;
7. optional playbooks.

The core task state machine and client UI remain unchanged.

Adding a new diagnosis flow should require a playbook and capability requirements, not a
new protocol adapter.

### 13.2 Versioning

- Contracts use explicit `schemaVersion` values.
- Adapters use independent semantic versions.
- Capabilities are additive by default; removing or changing input/output requires a new
  capability version.
- Runtime discovery is authoritative for the current device; static model claims are
  only support metadata.
- A capability snapshot is retained with every task so later adapter updates cannot
  rewrite history.
- Adapter updates are health-checked and can be disabled or rolled back independently.

### 13.3 Plugin boundary

The existing Plugin Manager and `plugin-sdk` are not a general third-party sandboxed
extension host. Device adapters should first use an internal adapter registry and
contract tests. A managed adapter plugin may be added later when packaging, trust,
signing, permissions, update, and removal semantics have been designed.

## 14. Open-source reuse

Ling should reuse or wrap existing projects rather than duplicate their low-level work:

| Project or ecosystem | Proposed Ling role |
| --- | --- |
| Home Assistant | First external device adapter and integration catalog |
| MeshCentral / SSH / WinRM | PC connection or target-side execution options |
| EdgeX-style device services and profiles | Architecture reference for device abstraction |
| MCP | Model-facing tool exposure where it fits |
| Matter, ESPHome, Zigbee and BLE libraries | Device and transport implementations |
| OpenXC / OVMS / OBD libraries | Vehicle interface and diagnostic adapters |

No external project becomes a required dependency of the core until a concrete adapter
needs it and its license, maintenance, security, and deployment cost are reviewed.

## 15. Observability and evidence

Every task emits structured events:

```text
device_task_created
device_target_resolved
device_capabilities_loaded
device_plan_created
device_approval_requested
device_action_started
device_action_finished
device_verification_finished
device_evidence_created
device_task_finished
```

The user-facing transcript shows a compact operation and a final explanation. Raw
protocol frames, command output, adapter diagnostics, and redacted artifacts remain
expandable evidence. The event source, adapter version, target id, and task id must be
preserved for later review.

## 16. Recommended delivery order

1. Stabilize contracts, registry, capability descriptors, policy, and task recovery.
2. Implement a read-only Home Assistant adapter and a small set of diagnosis playbooks.
3. Implement the PC adapter and target-side executor for software diagnostics.
4. Extend the mobile Remote Gateway with device task projection and approvals.
5. Add routers, NAS, printers, Android, and other external systems.
6. Add vehicle adapters only after diagnostic hardware, protocol, and safety acceptance
   are defined.

The detailed one-by-one record is maintained in the implementation plan linked at the
top of this document. Each slice must record its code scope, validation commands,
acceptance evidence, remaining work, and whether the result is local-only, simulated, or
field-verified.
