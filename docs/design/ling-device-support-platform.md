# Ling Device Support Platform

Status: approved architecture baseline; implementation not started
Owner: Ling platform maintainers
Last verified: 2026-11-19
Document type: canonical product and technical design
Canonical replacement: none
Code and test anchors: `docs/architecture.md`, `apps/mobile/README.md`,
`packages/daemon`, `packages/core`, `packages/contracts`,
`packages/remote-protocol`, and `packages/runner-pi`

The delivery checklist is maintained in
[Ling Device Support Platform Implementation Plan](ling-device-support-platform-implementation-plan.md).
The [Runtime Contract](ling-device-support-platform-runtime-contract.md) specifies
capability negotiation, approvals, failure handling, and acceptance for both
execution hosts.
Session modes, PC-assisted Mobile execution, self-hosted connectivity, and device
case flows are specified in
[Device Developer Execution and Connectivity](ling-device-developer-execution.md).

## 1. Purpose

Ling Device Support Platform lets a user use Ling Mobile or Ling PC to configure,
diagnose, repair, and understand external devices. A device can be a computer, a Home
Assistant installation, a router, a printer, a NAS, an Android device or head unit, a
vehicle interface, or another supported system.

The daemon or the phone owns the task and its device connection. The selected model
runner plans work through device capabilities. The owning host validates and executes
the operation through an adapter.

```text
Ling PC / Ling Mobile
        |
        v
Daemon or Mobile task owner
        |
        +-- task orchestration, policy, approvals, audit, recovery
        +-- planning through Runner-Pi, the Mobile loop, or a local playbook
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

An adapter translates a stable Ling capability into a protocol-specific operation.
The same capability contract works on a directly connected phone or PC. Paired
clients use authenticated sync to follow the task and collaborate.
[Execution architecture](ling-device-developer-execution.md#2-execution-architecture)

## 2. Product boundary

### 2.1 Goals

- Give a non-technical user one natural-language entry point for external device work.
- Reuse existing device ecosystems and protocols instead of rebuilding every driver.
- Expose typed, discoverable device capabilities to the model runner.
- Keep planning, permissions, execution, verification, and evidence separate.
- Support daemon tasks from Ling PC and paired Ling Mobile, and let Ling Mobile run
  supported tasks on devices it can reach directly.
- Support developer workflows from project build and test through target deployment,
  debugging, and verification. Offer authorized native workbenches for developers.
- Let a remote PC contribute analysis or build artifacts to a phone-owned task.
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
- Claiming that a hardware failure can be repaired remotely.

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
| Remote Gateway / daemon | Pairing, authenticated sessions, daemon-owned tasks, and scoped peer collaboration messages | Ownership of Mobile device tasks |
| Mobile execution module | Local policy and approval, adapter dispatch, verification, and durable state for tasks owned by the phone | Daemon task authority or unrestricted access to device protocols |
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
  device-execution/               # local task owner and capability broker
  device-transport/               # native USB/BLE bridges
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

The capability descriptor defines the operation the model runner and policy engine
understand. The broker derives current availability and authorization from a fresh
device snapshot and the selected execution context. See
[capability negotiation and freshness](ling-device-support-platform-runtime-contract.md#2-capability-negotiation-and-freshness).

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
capability catalog and supported contract majors
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

The hardware protocol workbench covers connection discovery, capture, decoding,
offline replay, and validation of a device profile and adapter. Registered
capabilities use the same device contracts in standard sessions.
[Hardware Protocol Workbench](ling-hardware-protocol-workbench.md)

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

Developer sessions add project and authorized device capabilities such as artifact
deployment, app launch and testing, and scoped diagnostics. Operator-controlled
native terminals and vendor tools use the target's platform permissions. Their
controls are outside the model's capability broker.
[Developer workflow](ling-device-developer-execution.md#11-developer-workflow-and-native-tools)

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

- A task stores its execution owner, target device id, adapter version, capability
  snapshot, policy snapshot, input, and idempotency key.
- A reconnecting client reads durable state; it does not infer cancellation from a lost
  stream.
- Read-only operations can retry within their declared policy and task budget.
- Verification is a separate step. An adapter returning without an error is not proof of
  a repaired device.
- Unknown outcomes are preserved when the transport fails after dispatch. The system
  must not automatically repeat a possibly mutating action.
- Cancellation closes pending dispatch. An action already in flight may still affect
  the device, so the task preserves the distinction between the stop request and its
  verified outcome.

Both execution hosts follow the same task state, approval, verification, and recovery
rules. See
[cancellation, verification, and recovery](ling-device-support-platform-runtime-contract.md#4-cancellation-verification-and-recovery)
for dispatch intent, readback, and recovery behavior.

## 10. Security and permissions

### 10.1 Identity and pairing

- Mobile-to-gateway pairing reuses the existing secure-key and signed remote protocol
  boundary.
- Device adapters have independent target credentials and revocation state.
- Every device task records the initiating user, client, execution owner, adapter, and
  device identity. Tasks routed through the Remote Gateway record that gateway as well.
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
- Treat device data as observation. Target selection, permission changes, and approvals
  require authenticated Ling commands or policy decisions.

### 10.4 Physical and safety-sensitive devices

Vehicle actuation, locks, alarms, power equipment, and firmware writes require separate
capability classifications and explicit acceptance. Diagnostic read operations and
configuration operations must not be silently promoted to physical control.

## 11. Connectivity topologies

| Topology | Execution location | Typical use |
| --- | --- | --- |
| Local PC | Ling daemon and adapter on one computer | PC diagnostics, local Home Assistant, NAS and router APIs |
| Mobile remote | Mobile -> Remote Gateway -> daemon adapter | Phone as the user-facing control surface for daemon-owned tasks |
| Standalone Mobile | Phone owns the task and uses a native transport | Supported peripherals that expose an authorized interface over BLE, USB, or a supported local network protocol |
| PC-assisted Mobile | Phone owns the task and target link. Paired PC contributes plans, artifacts, or analysis. | Phone at the device with a remote PC build or planning workspace |
| Target-side executor | Remote Gateway -> service installed on target | Windows software repair, privileged system checks |
| Hardware bridge | Mobile/Remote Gateway -> OBD/CAN/BLE/USB module | Vehicle and devices without a network API |
| Ling Server relay | Paired phone and PC use an end-to-end encrypted relayed connection | Cross-network sync when a direct path is unavailable. Proposed in [D12](ling-device-support-platform-implementation-plan.md#d12-ling-server-connectivity). |

The [failure matrix](ling-device-support-platform-runtime-contract.md#5-failure-and-placement-matrix)
specifies what the owning host can still observe or execute when a link, model service,
or target is unavailable.

### 11.1 Standalone Mobile execution

The daemon owns tasks using a PC adapter. For a Mobile-owned task, the phone owns
the task and runs the adapter over a native transport. It can run independently or
invite a paired PC to assist. At task creation, Ling offers the hosts that can reach
the target and run the requested capability. The selected host retains ownership
after a connection failure.
An independently authorized host can read the device to help reconcile the outcome.
Any follow-up write on a different host starts a separate task after reconciliation.

The phone uses the same schemas for target identity, capabilities, approval, task state,
and evidence. Its execution module checks the capability snapshot, binds user approval
to the target and operation, dispatches the action, and reads back the result. The
adapter handles target authorization through the device's documented interface. Native
transport modules handle OS permissions and communication.

The phone can use a configured model service for planning and explanation. The model
receives only permitted, redacted observations, while the phone checks and runs each
action locally. A bounded playbook can also run with no model service available.

The support matrix records the phone OS, transport, adapter version, and target model
and firmware. An adapter advertises a recovery capability when the target exposes
the corresponding interface in its current state and the phone can use it. D9 uses
a foreground smart-home BLE setup and network readback to verify phone independence.
Linux and Android workflows cover their own transports and verification.
[D9](ling-device-support-platform-implementation-plan.md#d9-standalone-mobile-execution) ·
[Device case flows](ling-device-developer-execution.md#4-case-flow-linux-device-with-wi-fi-trouble)

## 12. Storage and API shape

Daemon-owned tasks use workspace SQLite and artifact storage. Mobile-owned tasks
persist their state and redacted evidence in app storage. Before dispatching a write,
the phone saves the approved attempt. On resume after app suspension or disconnect, it
checks the target state and records `unknown` if it cannot verify the outcome.

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
- The broker selects a shared contract major before dispatch. Strict manifest and
  action validation use the selected schema, while display-only metadata can be
  additive within a supported version.
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
| dsh-Go | Architectural reference for capability negotiation, native approval, and interrupted actions |

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

The user-facing transcript shows a compact operation and a final explanation. Redacted
adapter diagnostics, action output, and verification artifacts remain expandable
evidence. The event source, adapter version, target id, and task id must be preserved
for later review.

## 16. Recommended delivery order

1. Stabilize contracts, registry, capability descriptors, policy, and task recovery.
2. Implement a read-only Home Assistant adapter and a small set of diagnosis playbooks.
3. Implement the PC adapter and target-side executor for software diagnostics.
4. Extend the mobile Remote Gateway with device task projection and approvals.
5. Validate standalone Mobile and its recovery workflow against the shared
   contracts. This work can run alongside Remote Gateway delivery.
6. Add Linux, Android, routers, NAS, printers, and other adapters with individual
   device acceptance. Verify vehicle diagnostics against its own hardware and protocol.
7. Verify developer sessions on each host and paired collaboration for phone-owned tasks.
8. Validate Ling Server direct and relay connectivity using the same signed task sync.

The detailed one-by-one record is maintained in the implementation plan linked at the
top of this document. Each slice must record its code scope, validation commands,
acceptance evidence, remaining work, and whether the result is local-only, simulated, or
field-verified.
