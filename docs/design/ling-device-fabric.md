# Ling Device Fabric Detailed Design

Status: proposed design. Runtime implementation and field acceptance are tracked separately.
Owner: Ling platform maintainers
Last verified: 2026-11-20
Document type: cross-device execution and state contracts

Related documents:
[Device Support Platform](ling-device-support-platform.md) ·
[Runtime Contract](ling-device-support-platform-runtime-contract.md) ·
[Developer Execution](ling-device-developer-execution.md) ·
[Hardware Protocol Workbench](ling-hardware-protocol-workbench.md) ·
[Ling Server Connectivity](ling-server-connectivity.md) ·
[D14–D22 implementation and evidence](ling-device-support-platform-implementation-plan.md#d14-semantic-device-graph-and-twin)

## 1. Product workflow

The same Ling conversation can diagnose a PC, work with an Android head unit, trace a
wired sensor, or configure a supported home device. The user selects a target and can
see where Ling will act, which observations support the plan, and what was verified.
Developer sessions add the project build, protocol workbench, and operator tools
described in D10 and D13.

An existing device task and its journal are the unit of execution. A cross-device task
graph composes these tasks with project work and verification. The coordinating host
owns graph revisions and progress. Each node's execution host owns its actual
connection, authorization checks, attempts, and evidence. Ling can use a cloud model,
a local model, or a supported local playbook for the planning and explanation steps.

## 2. Unified architecture

~~~mermaid
flowchart TB
  UI["Ling PC or Mobile conversation"]
  Model["Existing model runner or local playbook"]
  Context["Task-scoped device context"]
  Registry["Device registry, capabilities and state"]
  Graph["Cross-device task graph and coordinator"]
  Data["Versioned profiles, adapters and evidence"]
  Events["Owner journals and event projections"]
  Server["Ling Server connectivity and peer sync"]

  subgraph Hosts["Hosts that own execution"]
    PC["PC daemon, project and device broker"]
    Mobile["Mobile execution and device broker"]
    Edge["Linux edge executor and device broker"]
  end

  UI --> Model
  Registry --> Context --> Model
  Events --> Context
  Model -->|"Typed proposal"| Graph
  Graph -->|"Authorized node requests"| PC
  Graph -->|"Authorized node requests"| Mobile
  Graph -->|"Authorized node requests"| Edge
  PC -->|"Local APIs and authorized adapters"| Systems["PC services and project tools"]
  Mobile -->|"Authorized Wi-Fi, USB or BLE"| Car["Head unit or peripheral"]
  Edge -->|"Protocols and local controllers"| Hardware["Hardware and smart-home devices"]
  Hosts --> Events
  Data --> Hosts
  Server <-->|"Paired projections and collaboration"| Hosts
~~~

| Boundary | Authority and placement |
| --- | --- |
| Device registry and state | Scoped records owned by the installation that enrolled the target or connector. Peers receive the projection their pairing and target scope allow. |
| Graph coordinator | Durable parent graph on the host selected at creation. It derives progress from each node owner's revision and receipt. It can be the phone for an independent Mobile workflow. |
| Execution | The owner with the authorized connection holds the adapter, local journal, target lease, credential access, and final dispatch decision. |
| Peer communication | Reuse Ling Server's identity, direct or relayed transport, and synchronization. The server coordinates reachability. Business records and target credentials reside on their respective hosts. |
| Repository integration | Extend the device contracts and workbench. Reuse existing Run, WorkUnit and Attempt records for PC project work, and Remote Access for paired projections. Mobile and edge implement the portable device contracts with platform adapters. |

The broker interface and portable schemas define the shared behavior. A host's device
executor can run independently of the model runner. The daemon can continue to use
Runner-Pi for planning and project work, including work that produces an artifact for
a phone-owned task. [Platform component layout](ling-device-support-platform.md#5-proposed-component-layout) ·
[Ling execution capabilities](agent-execution-capabilities.md)

## 3. Semantic device model

### 3.1 Identity and relationships

| Record | Fields needed at the boundary |
| --- | --- |
| Device record | Installation-scoped opaque ID, device kind, model and firmware when known, profile revision, location, ownership and lifecycle revision. |
| Component | Parent device ID, stable component ID, purpose, and capability references. Components can be a network interface, sensor channel, head-unit app or Home Assistant entity. |
| Connection reference | Adapter instance and endpoint, reachable execution host, transport, authorization scope, connection revision and status. A device can have several references. |
| Identity assertion | Source installation, adapter instance, external identifier, observation and verification evidence. Endpoint addresses and display names are discovery hints. |
| Relationship | Source and destination IDs, relationship type, author or observation source, time, validity and optional confidence. |
| Capability descriptor | Capability ID and schema version, component, supported operation and effects, input and result schemas, prerequisites, approval class and verification rule. |

Resolve identity within the authorized installation or workspace scope. A Home
Assistant entity ID is namespaced to its integration instance. A BLE address can
change. When identities might refer to the same target, collect adapter-backed
identity evidence or ask the operator. Preserve redirects and revision history after
a merge so historical receipts still identify their original target. Refresh affected
bindings before executing new writes. Keep scopes and credential references attached
to the authorities that issued them.

Relationships answer questions such as which room contains a device, which controller
reports it, what network it uses, and which host reaches it. A relationship can help
choose an observation. Authority comes from the current identity, connection and
policy records.

### 3.2 Capability resolution

Normalize concepts such as read a measurement, inspect network state, deploy a test
application, and verify a configured value. The actual action binds a concrete
capability, target component, adapter and execution host. For example, a measured
temperature can come from a Home Assistant entity, BLE characteristic, or a register
in a documented Modbus sensor. The binding says which source supplied the value
and its unit, timestamp and quality. The adapter declares the actual measurement
schema, available transport and verification rule.

The resolver presents choices when a location or label matches multiple targets.
A capability snapshot binds the device, component, adapter, connection, device
profile and authorization revisions. On discovery, distinguish unsupported,
unavailable, stale, and available. A newer model or a richer profile changes the
choices offered. Dispatch validates the chosen capability and snapshot again.
[Capability negotiation and freshness](ling-device-support-platform-runtime-contract.md#2-capability-negotiation-and-freshness)

## 4. Device twin and state model

The device twin is a materialized view of each owner's observations and task journal.

| State view | Source and freshness |
| --- | --- |
| Reported | An observation from a named adapter, target or instrument. Keep source, generation, sequence, receipt time, observation time and freshness allowance. |
| Desired | The target value approved for a particular capability, node, target revision and expiry. |
| Pending | The owner has recorded a dispatch intent or a later attempt state. Show the last confirmed observation while verification is pending. |
| Verified | A readback or approved verification procedure produced evidence matching the node's rule and attempt. Retain the result and time of verification. |

State events carry the source and evidence references. Resolve observations of a
property with the adapter's documented authority and freshness rules. Preserve
contradictions, gaps and unavailable readings for diagnosis. Sequences order one
source's events. Timestamps record what was observed and can differ across devices.
A reconnect or profile change can invalidate an old observation. A historical
verification remains valid as evidence of the attempt it verified.

~~~mermaid
stateDiagram-v2
  [*] --> Planned
  Planned --> Approved: User decision recorded
  Approved --> Pending: Owner records intent
  Pending --> Verified: Readback satisfies the rule
  Pending --> Unknown: Link lost or outcome uncertain
  Pending --> Failed: Verified failure
  Unknown --> Verified: Reconciliation observes success
  Unknown --> Failed: Reconciliation proves failure
  Verified --> [*]
  Failed --> [*]
~~~

A transport acknowledgment advances the attempt record. The target observation and
verification rule determine the verified state. A desired value is an intent record
attached to its approval and expiry. Reconnect rebuilds observations, pending states
and receipts. A repair with a declared recovery step uses the runtime's own recovery
contract and authority checks.

## 5. Cross-device task graph

### 5.1 Graph and dispatch contracts

| Record | Fields and consistency |
| --- | --- |
| Graph | ID, requesting principal, coordinating host, goal, revision, node IDs, dependency edges, authorized target scope and projected outcome. |
| Node | ID and revision, kind, dependency predicates, capability and target binding or project WorkUnit reference, selected owner, inputs and evidence references, and verification requirement. |
| Approved action | Node and action IDs, target and connection revisions, selected execution host, normalized payload or artifact digest, approval ID, policy revision, expiry and expected readback. |
| Attempt and receipt | Device-task and attempt IDs, owner, dispatch intent, durable outcome, verification references, and revision. |
| Dependency | Source node, required output and predecessor status, optional timeout and an explicit recovery or observation branch. |

The coordinator validates proposals for supported node types, acyclic dependencies,
reachable hosts, authorized target scope, typed inputs and required verification.
Nodes may carry observations, user decisions, project work, device actions, waits,
or verification. Changes create a new revision. Keep approval for steps whose bound
fields are still current. Resolve changed bindings and review those steps again.

A node becomes eligible when accepted owner records satisfy its dependency predicates
and current inputs. An observation or recovery branch can depend on an unresolved
attempt and still checks the target and permissions. The selected host checks its
actual session and authorization, holds the required
lease, and records the action ID and dispatch intent before execution. Repeated
requests with the same ID and payload return the stored receipt. A different
payload with that ID is a conflict. The graph may include independent concurrent
reads. It orders competing actions on a target or shared bridge using the adapter's
declared coordination mechanism.

A per-host lease guards that host's port or adapter. Cross-host exclusive operations
require an authoritative target session or conditional write as described in D3.
The coordinator can reconcile an uncertain attempt with fresh read-only evidence.
A change of owner after a possible device change requires reconciliation and a
separate approved follow-up task. Reconnect resumes the journal with the original
owner and attempt.

### 5.2 Failure and aggregate result

| Condition | Graph response |
| --- | --- |
| Proposal or approval becomes stale | Refresh target and capability evidence. Request a new decision for the changed action. |
| Coordinator restarts | Rebuild from the stored graph revision and accepted owner receipts. Query outstanding attempts before advancing dependent nodes. |
| Execution host or target disconnects | Keep completed nodes and their evidence. Mark uncertain effects and wait for owner reconciliation within the task's budget. |
| User cancels or revokes | Apply the existing per-node cancellation contract. Record which in-flight effects still require verification. |
| Evidence shows failed verification | Report the failed condition and completed nodes. Use an authorized recovery node when the target and capability support it. |
| Required nodes all verify | Commit the parent result and link each contributing receipt and observation. |

The parent result distinguishes verified success, partial progress, failure,
cancellation and unresolved outcome. A downstream step receives the named
predecessor result. A missing or stale observation surfaces as a condition for
the user or the planner to resolve.

### 5.3 PC-assisted head-unit application task

~~~mermaid
sequenceDiagram
  actor U as User at the vehicle
  participant M as Mobile coordinator and device owner
  participant P as PC project executor
  participant H as Authorized parked head unit
  U->>M: Request application installation and retest
  M->>H: Observe device identity and supported installer
  M->>P: Request project build or artifact verification
  P-->>M: Return verified artifact and project receipt
  M->>U: Show exact target, update and verification plan
  U->>M: Confirm supported app deployment
  M->>H: Dispatch the authorized app action
  H-->>M: Return installer result
  M->>H: Read back app identity and version
  M-->>U: Record user retest and per-node evidence
~~~

The PC project action uses the existing project runner. The phone binds the returned
artifact and its digest to the authorized head-unit deployment. Verify the installed
version, then capture the user's functional retest and link it to the device attempt.
A missing artifact leaves that node pending. For a phone-only task, the phone can
use a verified release artifact and supported installer directly.
[DiPlay case flows](ling-device-developer-execution.md#5-case-flow-install-diplay-on-an-older-head-unit)

### 5.4 Smart-home and hardware diagnosis

For an offline workbench humidity sensor, the registry relates the Home Assistant
entity, the installed sensor and the gateway that reports it. The home adapter checks
entity availability and last observation. A PC or Linux edge host with the authorized
bridge checks gateway health and reads the documented sensor next. If the phone has
an independently supported route, its broker can supply a local observation and
project the evidence with the same device identity. The user sees whether the physical
measurement, bridge link or home integration was last verified.

Allow a documented, authorized noncritical configuration repair where the integration
supports it. Read back the exact setting and verify that the home entity receives a
fresh measurement. A graph lacking evidence reports the last verified stage.
[Home Assistant device registry](https://contributors.home-assistant.io/core/integrations/device-registry/) ·
[Hardware protocol workbench](ling-hardware-protocol-workbench.md)

## 6. Edge runtimes and bridge contract

| Placement | Device connection and execution |
| --- | --- |
| PC daemon | Project work and typed adapter actions for authorized local devices or PC, Linux and home APIs. |
| Standalone Mobile | Locally reachable devices over supported BLE, USB, LAN or a local bridge. The phone keeps the task journal and can run a local playbook. |
| PC-assisted Mobile | PC owns its project nodes and returns an artifact or analysis. Mobile dispatches and verifies its device nodes. |
| Linux edge executor | Always-on host authorized to keep its own journal and access a target over an installed protocol adapter. |
| Hardware bridge, vehicle gateway or home controller | Translates a physical or ecosystem interface. Its owning host handles Ling tasks. A gateway acting as a Ling executor enrolls for that separate role. |

An executor advertises its runtime identity, protocol version, supported and
currently usable transports, profile revisions and health. The device broker
supports the existing discover, connect, observe, execute, verify, cancel and
disconnect contract. Hardware capture uses D13 provenance. A bridge reports its
channel, link identity, timing and capabilities to the host that owns the device
task. A native transport module shares the execution host's identity and lifecycle.

Edge installation enrollment uses an expiring operator grant and device-key proof.
Authenticate a peer before granting access to scoped graph projections. Extending
D12 to edge peers requires a versioned capability for that peer role. Local bridges
can work as adapter transports without Internet access. On restart an executor
reopens its local journal, restores its installation identity and reconciles live
devices. Treat an old blocked or disconnected write as unresolved until there is
evidence. [Ling Server enrollment](ling-server-connectivity.md#3-server-enrollment-and-peer-trust)

## 7. Event and telemetry plane

Every event identifies its owner stream, generation, sequence, subject and schema
revision. Include event identity, observation and receipt times, provenance, tenant
or workspace scope, redaction class and the related attempt when applicable.

- Append authoritative task transitions, approvals and receipts with the owning durable
  record. Publish from the committed journal or outbox. Consumers deduplicate the
  event and advance the cursor after applying the projection.
- When a consumer detects a gap, use a retained range or a fresh scoped snapshot
  followed by events. Reuse D12's rule about the matching materialized snapshot.
  Honor source generation and invalidated access when applying a cached projection.
- Keep high-rate telemetry and raw protocol captures local with a bounded retention
  budget. Mark lost or downsampled readings. Preserve the evidence reference and the
  reason when a gap prevents a diagnosis.
- Medium-specific events enter through their adapter, including Home Assistant state
  and MQTT telemetry. The projected Ling event format is independent of the transport.
  Use the existing owner journals and peer sync for the durability contract. Evaluate a
  broker such as NATS where measured edge workloads need one.

## 8. Model context and AI orchestration

Build a bounded context pack per task from resolved targets, allowed relationships,
capability snapshots, recent observations, relevant excerpts, known missing evidence
and the current graph state. The model sees time and source for each observation. A
tool response can provide typed data and a redacted evidence reference. The owning
host keeps credentials and permission records. Refresh a stale pack after a target,
connection, resource or policy revision changes.

Use the existing runner and provider configuration to propose a supported observation,
typed graph or explanation. The dispatcher handles identities, parameters, leases and
authorization from their authoritative records. Treat text in device output, profiles,
reports and captured messages as observations. It may describe a fault or suggest a
hypothesis. It cannot supply an approval, select a secret or alter target authority.

A change of planner or provider uses a refreshed context pack for the same graph.
Node journals and attempts belong to their owners. If the model service is unavailable,
run a supported deterministic local playbook using available evidence and current
authorization. Mark what remains pending for a later model turn or operator.

The local PC diagnosis route and the enrolled Linux diagnosis route accept an
optional `providerPresetId` and `symptom`. The Daemon uses Pi to select an ordered
set of available diagnosis steps. It validates the output, binds it to the owner
and current capability snapshot, and records it before dispatch. The same routes
run the local playbook when the operator leaves the preset unselected or the model call is interrupted
by a provider outage. The task trace records the source and any fallback.
[Diagnosis routes](../../packages/daemon/src/features/device-support/routes.ts)

## 9. Resource and adapter registry

The catalog indexes versioned device profiles, codecs, protocol descriptions, register
maps, GATT and DBC definitions, documentation, playbooks, fixtures, adapter packages
and vendor release metadata. A manifest binds the publishing identity, artifact digest,
license, compatibility with model and firmware, host and Ling contract versions,
required capabilities, dependencies and the supported update path.

| Resource class | Delivery and activation |
| --- | --- |
| Structured profile, protocol definition and fixture | Validate signature, digest and schema. Apply as data to the installed interpreter and store the profile version with evidence. |
| Native codec, adapter or transport module | On Mobile, ship through the signed app build and platform release channel. On PC or edge, use the applicable bundled or authorized installation path and supported runtime. |
| Vendor firmware and maintenance tool | Use trusted release metadata for compatible model, firmware and signature checks. Hand the authorized operator to the vendor's maintenance workflow and record the supported readback. |

Stage resources by digest before changing the active revision. Run capability
negotiation and a health check. Existing tasks retain links to the revision they used.
An update that changes a live target binding pauses writes until the owner revalidates
the target and policy. When supported, restore the previous compatible resource if
activation fails. The lifecycle records both the activation outcome and any verification
still required. [Protocol profiles and captures](ling-hardware-protocol-workbench.md)

### Daemon resource imports

The daemon reads the resource publisher trust file at startup from
`deviceSupport.resourceTrustFile` or `LING_STACK_DEVICE_RESOURCE_TRUST_FILE`.
The version 1 JSON document contains an `allowedLicenses` array of license
identifiers and a `signingKeys` array. Each key has a `keyId` and
`publicKeyPem` containing an Ed25519 public key in SPKI PEM format.

Publishers sign the canonical JSON bytes of
`{ purpose: "ling.device-resource-manifest.v1", keyId, manifest }`. The signed
`manifest` object contains every manifest field except `signature`, including
the SHA-256 digest of the file. Its signature field uses
`ed25519:<keyId>:<base64url-signature>`.

The local operator imports a manifest and its base64url-encoded bytes through
`POST /v1/device-support/resources` with the JSON keys `manifest` and
`payloadBase64Url`. The JSON import accepts up to 4 MiB of resource bytes. The
registry exposes the active record through `GET /v1/device-support/resources/:resourceId`.
Append `/disable` or `/rollback` and use POST to change its active state.
The daemon checks publisher trust, license, digest, dependencies and host
compatibility before activation. Active payload reads and rollbacks recheck the
current trust policy. An unavailable rollback leaves the current revision active.
Adapter installation and applying a profile to a particular device remain
separate operations owned by the relevant runtime.
[Resource routes](../../packages/daemon/src/features/device-support/resource-routes.ts)

## 10. Safety, security, and secrets

The device broker evaluates actual target permissions, current capability and physical
conditions when dispatching. For example, verify the documented maintenance condition
before an application deployment to a parked head unit. A model's suggestion or
confidence cannot substitute for an operator decision or a trusted condition check.
A changed or unavailable condition prevents additional writes for that step. A Stop
request follows the owning adapter's cancel semantics and verifies the effect where
the target exposes one.

The local Daemon exposes `GET /v1/device-support/devices/:deviceId/dispatch-stop`
for the current stop state. The operator activates or clears it with `PUT` and
the fields `active` and `expectedRevision`. Activation journals a stop for the
currently leased task and requests cancellation from its adapter. New writes are
blocked while diagnostics can run once the active lease drains. A device-side
result remains unknown until readback establishes what happened.
[Daemon device routes](../../packages/daemon/src/features/device-support/routes.ts)

Support normal device controls and documented configuration actions through their
typed capabilities. Ling uses authorized vehicle observations and head-unit app
maintenance for the vehicle cases. Safety-critical vehicle, lock, alarm, power and
firmware operations use the certified controller or the operator's authorized vendor
workflow. Ling can collect permitted diagnostics and verification evidence. Device
policies and safety interlocks remain effective on the controller.

The execution host resolves a secret reference only for the authorized local action.
Journal the reason, target and policy decision. The model and peer projections receive
authorized, redacted results. Peer enrollment, home or workshop membership, and
device authorization are checked independently. Revoke target access at the owning
brokers and invalidate affected future dispatch. Report outstanding effects separately.
[Approval and dispatch](ling-device-support-platform-runtime-contract.md#3-approval-and-dispatch)

## 11. Lifecycle, fleet, and ownership

Keep ownership, operational health and current task outcome as separate records.
Discovery produces a candidate. Enrollment binds target and connector identities and
their authorization. A validated profile establishes available capabilities.
Health and maintenance follow the latest verified device and adapter observations.

An ownership transfer revokes the previous authorization and validates the new holder
and credentials before offering more actions. Ongoing or unknown attempts remain
visible to the authority responsible for their reconciliation. An access grant can
permit scoped reads without granting the ability to approve changes. Device removal
closes leases, expires live projections and retains historical records under the
applicable retention policy. Rotation invalidates affected bindings and rechecks
current device permission.

Track the installed executable, adapter, profile and target firmware revisions and
show operator-supported upgrade and recovery paths. An adapter or executor upgrade
uses a staged installation, a health check and the supported rollback path. Vendor
device maintenance follows its documented workflow and its own verification evidence.

## 12. Observability, simulation, and conformance

Correlate interaction, graph, node, owning runtime, device, attempt, capability and
evidence IDs. Link project WorkUnit or model turn when available. Device capture
retains provenance at the host. A shared trace carries authorized references and
redacted status across hosts. Use OpenTelemetry conventions where they fit existing
observability.

The local operator reads a Daemon-owned trace through
`GET /v1/device-support/tasks/:taskId/trace` on the authenticated loopback API.
The projection uses the same workspace and trace identity as the owner journal.
It links the accepted plan, the exact adapter/profile and connection used for each
attempt, and the public evidence references from verification or reconciliation.
An interrupted dispatch keeps its status when a later readback verifies the
target. Each readback records its own connection revision.
[Trace projection](../../packages/core/src/device-task-trace.ts)

| Test layer | Evidence |
| --- | --- |
| Contract and state | Identity aliases, allowed exposure, profile/schema compatibility, revision changes, ordered journal replay and stale evidence. |
| Graph and authority | Distinct node owners, duplicate dispatch, changed scope, partial results, controller or peer outage, and recovery with original receipts. |
| Protocol and edge | Decoder replay, loss accounting, simulator and hardware-in-loop checks, real USB/BLE/RS-485 or other supported transport combinations. |
| Model and resources | Bounded evidence, untrusted text in observations, unchanged dispatch authority after planner fallback, and signed resource activation and rollback. |
| Field | Parked head-unit app task, PC project or bench verification, phone-only execution, and home/edge sensor diagnosis on declared supported devices. |

Record the host and target versions, adapter, profile and protocol, network path,
fixture or physical evidence, verified result and open conditions for each run.
The cross-domain case set exercises PC, Mobile, head unit, hardware and smart home
with shared contracts. Each real-device claim links to its own measured result.

## 13. Domain mappings

| Domain | Device and component examples | Adapter surface |
| --- | --- | --- |
| PC and Linux | Host, service, network interface, package or workspace | Daemon project work and authorized SSH, WinRM or platform diagnostics. |
| Mobile and head unit | Phone, Android unit, installed app, link and foreground session | Platform permissions, supported package installer, authorized ADB, BLE, USB or LAN. |
| Vehicle data | Vehicle, documented diagnostic observation and verified signal source | Supported diagnostic adapter and read-only field or simulator evidence. |
| Hardware | Bridge, board, bus, sensor channel and register | D13 capture and documented USB, BLE, serial or CAN interfaces and codecs. |
| Smart home | Installation, area, device, entity and scene | Existing Home Assistant or supported Matter, Zigbee, ESPHome, MQTT and vendor adapters. |

## 14. Open-source and standards references

| Source | Relevant design pattern |
| --- | --- |
| [W3C Web of Things Thing Description](https://www.w3.org/TR/wot-thing-description11/) | Versioned descriptions for properties, actions, events and protocol bindings. |
| Home Assistant and Matter | Map devices, entities and endpoints to typed capabilities and supported controller APIs. [Device registry](https://contributors.home-assistant.io/core/integrations/device-registry/) · [Matter SDK](https://github.com/project-chip/connectedhomeip) |
| [Zigbee2MQTT](https://github.com/Koenkk/zigbee2mqtt) and [EdgeX device services](https://github.com/edgexfoundry/edgex-go) | Keep device-specific access behind connectors and preserve domain-specific metadata. |
| [Eclipse Ditto](https://github.com/eclipse-ditto/ditto) | Compare reported properties and device representations with local state projections. |
| COVESA VSS and Eclipse KUKSA | Reference for named vehicle signals and a typed observation interface on authorized sources. [VSS](https://github.com/COVESA/vehicle_signal_specification) · [Eclipse KUKSA](https://eclipse-kuksa.github.io/kuksa-website/) |
| [Node-RED](https://github.com/node-red/node-red) and [Temporal](https://github.com/temporalio/temporal) | Reference for event-driven composition, workflow checkpoints, and durable recovery. |
| [NATS](https://github.com/nats-io/nats-server) and [OpenTelemetry](https://opentelemetry.io/docs/) | Reference for messaging boundaries, cross-process trace correlation and observability. |
| [Eclipse hawkBit](https://github.com/eclipse-hawkbit/hawkbit) | Reference for staged edge software rollout and delivery evidence. |

Record version, license, platform support and observed behavior for any component chosen
for packaging. The shared Ling contracts own the semantics and interoperability fixtures.

## 15. Acceptance and delivery slices

The implementation plan tracks D14–D22 individually from contract fixtures to
real-device evidence. Extend D1–D3 for shared identity, capabilities and reliable
actions. Reuse D4 and D8 for domain adapters, D9 and D11 for Mobile execution and
collaboration, D12 for peer sync, and D13 for hardware evidence. Deliver the complete
cross-domain workflow by composing those modules. Final acceptance exercises distinct
host/target combinations, verified physical outcomes, and disconnect or revocation
during an in-flight step.
[D14–D22 implementation and evidence](ling-device-support-platform-implementation-plan.md#d14-semantic-device-graph-and-twin)
