# Ling Device Support Platform Runtime Contract

Status: proposed runtime and acceptance design
Owner: Ling platform maintainers
Last verified: 2026-11-19
Document type: detailed device execution contract
Related design: [Ling Device Support Platform](ling-device-support-platform.md)
Delivery ledger: [Implementation Plan](ling-device-support-platform-implementation-plan.md)
Related workflows and topology: [Device Developer Execution and Connectivity](ling-device-developer-execution.md)
Cross-device execution model: [Ling Device Fabric](ling-device-fabric.md)

## 1. Execution owner

The daemon owns tasks using its device adapter, including tasks controlled by a paired
Mobile client through the Remote Gateway. The phone owns tasks using its local
adapter, including tasks with PC assistance. Each task has one owner with a durable
journal and a broker that checks device identity, current capabilities, and
authorization. Both owners use the same schemas and acceptance fixtures. The runner
can propose an operation using those schemas. The broker alone decides whether to
dispatch it.

Device reachability and the supported adapter determine which execution hosts Ling
offers. A client reconnect reads the owning host's journal. A backend disconnect,
adapter restart, or model change leaves the task with its original owner. An
independently authorized host can supply read-only observations for reconciliation.
A follow-up write on a different host starts a separate task after the original outcome
and target state are reconciled.

Each device action addresses a task node, external target, and owning execution host.
Project workspace actions address their project executor separately. The graph
coordinator owns the parent revision and uses accepted owner receipts to update its
progress. Each device node retains its own execution host, task journal, target
binding and approval scope. Its owner validates the proposed action against current
capabilities and records the attempt and verification. A paired peer resumes the
authorized projection at the last accepted revision.
[Cross-device task graph](ling-device-fabric.md#5-cross-device-task-graph)

## 2. Capability negotiation and freshness

### 2.1 Contract versions

When an adapter is registered or connected, the broker selects a mutually supported
contract major. For each usable capability it selects the input and output schema
version that matches that contract. The adapter implementation version is recorded
for diagnosis and reproducibility. Any capability with an incompatible contract or no
verified support on the selected device is unavailable to planners.

An older client can display the fields it understands and ignore optional display
metadata and unrecognized capabilities within a supported protocol major. The broker
strictly validates registered manifests, approval input, and action parameters against
their selected schemas. Incompatible versions give an explicit error. Unsupported
negotiation can preserve a known compatible status view where one exists. Approval
requires a client that understands and displays the required confirmation fields.

V1 capability schemas use `type`, `properties`, `required`, `additionalProperties`
as a boolean, `items` as a single schema, numeric `minimum` and `maximum`, and
scalar `enum` values. `title` and `description` are annotations. The Daemon
rejects unsupported schema keywords and repeated IDs at adapter registration.
Discovery can omit capabilities, narrow the supported device kinds and transports,
and supply display metadata. The other fields match the registered descriptor.
The owner validates the normalized action input before admitting it. Historical
snapshots retain the schema and identifier originally recorded.

### 2.2 What discovery establishes

| Question | Source and meaning |
| --- | --- |
| Is this capability implemented for this device? | The adapter catalog and target probe establish support for the target model, firmware, and operation version. |
| Is it available now? | The live connection, prerequisites, and current device state establish whether it can run. Last known status is marked stale when discovery cannot refresh it. |
| May this user run it? | The broker evaluates the OS transport permission, target authorization, Ling policy, and approval required for the action. Discovery alone establishes support or readiness. |

Store the snapshot ID, stable device identity, execution owner, adapter and contract
versions, connection revision, capability schema versions, and observation time. Record
the capability's freshness limit and any applicable permission or policy revision.
An explicitly empty catalog means discovery completed and found no supported
capabilities. Failed or unavailable discovery shows the reason and, if present, a
separately marked last known snapshot.

Mark a snapshot stale after expiry or a change to the target, firmware, adapter,
connection, or recorded authority. A reconnect triggers a new identity and capability
check. At dispatch, recheck the current target and relevant prerequisites even if the
snapshot has time remaining. Retain the original planning snapshot and link any
refreshed snapshot used to dispatch the action.

The Daemon retains each capability snapshot under its device and snapshot IDs
with its workspace and profile revision. Refresh changes the current pointer.
A historical ID stays bound to its original facts. Dispatch and reconciliation
admit work using the current snapshot. The task trace identifies the snapshots
used for planning, dispatch and readback, with versioned capability summaries.
Upgrading an existing journal preserves each retained current snapshot. A task
that references an earlier snapshot missing from storage reports that evidence
as unavailable.

### 2.3 Errors and budgets

Expose stable categories for unsupported contract, unsupported capability, missing
target, invalid request, authentication required, permission denied, stale snapshot,
device offline, service unavailable, and timeout. Keep adapter details redacted. A
failed authentication or timeout remains distinct from an explicit unsupported
response. Include the action outcome separately from the error category so the same
timeout can describe either an action that never dispatched or one that may have
changed the device.

Each adapter operation declares a deadline and response size limit. Discovery,
reconnect, verification, and any retry share a bounded task budget. Read-only
operations may retry within this budget under the adapter's retry policy. Verification
has its own deadline within the budget, allowing the UI to identify a failed
observation separately from an action failure.

The Daemon and Mobile apply the action deadline to dispatch and its immediate
readback. Each owner checks the response size and binds the receipt observations
to the selected target. A late valid receipt remains in the journal with an
unknown outcome. The owner signals the adapter to stop work and holds the target
until the adapter settles.

## 3. Approval and dispatch

The approval view displays the intended device, execution host, proposed change,
expected impact, verification method, and recovery option. Show the execution identity
or privilege level when it affects the operation. Standard repair and setup flows
require explicit confirmation for each mutating action, including reversible actions.
A developer can confirm a specific plan containing individually displayed actions,
with one target and bound artifact when applicable. Each approved plan action receives
its own immutable dispatch scope and is subject to the same approval checks. The policy
can allow read-only observations under its ordinary scope.

1. Resolve the stable target and construct a typed action with normalized arguments,
   its capability/schema version, expected effect, and verification conditions.
2. Bind approval to the task and action, target, execution host, adapter and connection
   revision, capability version, normalized arguments, recovery scope, policy revision,
   and expiry. Use protected references for secret inputs. If a reference is necessary
   for approval, bind its identifier and version without storing the secret.
3. At dispatch, validate the arguments, current capabilities, device and OS
   authorization, approval, and relevant state. Expired approvals, changed scope, and
   stale authority require revalidation and a fresh decision before a write.
4. Hold the owning broker's target lease for the attempt. Serialize final authorization
   and the dispatch decision with cancellation and revocation. Save a durable dispatch
   intent and attempt ID before invoking the adapter. If persistence or validation
   fails, leave the device untouched. A repeat of the same authorized request
   resolves to the recorded attempt. Reject an attempt key reused with different
   action arguments or scope.
5. Use the configured adapter capability within the owner's lease and record its
   response. Verification reads the target state after the action.

The Daemon records the policy, operator-stop revision and access grant applied
at each dispatch and reconciliation read. The task trace exposes the authorized
scope, revisions and exact approval digest. A paired Mobile approval also records
the authenticated device ID, epoch, and Gateway session that presented it.
Request arguments, credential references and adapter payloads stay in their
owning records.

The lease serializes access on the owning host. Capabilities that require exclusive
access across hosts need a documented target session or conditional write that checks
the target revision. A capability without the required coordination is unavailable
for automated writes.

Password, system authorization, and recovery credential entry belongs in the approved
system or vendor UI or a local protected input. The model receives the redacted result.
A playbook may read another explicitly authorized device for diagnosis. Each write
remains scoped to the affected target and its own approval.

The operator's native workbench uses a separately authorized, target-pinned connection
or vendor UI. Opening it for maintenance suspends broker writes to that target on the
owning host until the session closes and the owner refreshes capability and target
state. When recording a workbench result, the journal identifies the operator and
tool and distinguishes their reported outcome from a readback observation.

## 4. Cancellation, verification, and recovery

### 4.1 Interruptions

| Event | Expected behavior |
| --- | --- |
| Stop, revoke, or expire before dispatch | Close the approval and stop pending writes. Report cancellation or the reason dispatch was denied. |
| Stop while an action may be in flight | Record the stop request, stop further dispatch and ask the adapter to cancel when supported. Preserve the possibility of a device change until there is evidence. |
| User pauses or a foreground authorization ends | Stop new dispatch for that session. On resume, revalidate target state and obtain fresh confirmation for pending writes. |
| Timeout, disconnect, or process exit after dispatch intent | Acknowledge an unknown outcome unless the adapter or target can prove the effect. Start with observation on an authorized path after reconnect. |
| Adapter recovers or reconnects | Invalidate old handles and refresh identity and capability state. Responses from the previous connection cannot authorize new work. Reconcile unknown attempts by reading the device. |
| Phone is suspended during a standalone task | Start no new writes while the foreground execution session has ended. On resume, restore the journal, re-evaluate permissions, and observe any attempt that may have dispatched. |

An adapter cancel response can prove cancellation for that attempt only if the
transport or target confirms the action could not take effect. A crash after the
journal records dispatch intent and before the adapter can acknowledge it is an
ambiguous outcome. The attempt and its original disposition stay in history. Later
observations are appended, with their time and source. After an ambiguous write, the
owner may perform read-only reconciliation. A subsequent write requires an observed
state that supports the action and a new approval.

When an external adapter process exits, mark that adapter unavailable and invalidate
its handles, pending requests, and live authority. Other adapters continue under
their own limits. The owner retains task and audit records across adapter restarts.

### 4.2 Results and recovery plans

Record three distinct results:

| Record | Evidence |
| --- | --- |
| Action response | The adapter returned an acknowledgment, an explicit rejection, or an uncertain response. |
| Device verification | A declared read-only observation meets, fails, or cannot evaluate the expected condition. Record the before and after observations where supported. |
| User outcome | The user's original issue is confirmed resolved, still present, or pending confirmation. Use verified evidence or the user's explicit report. |

Task success for a repair requires the declared device verification. A missing
readback leaves the outcome unknown where the action may have changed the target.
Known partial progress remains visible with any outstanding verification. A failed
or cancelled attempt records what is known about any device change.

Every mutating capability declares the baseline it needs, its expected effect,
verification deadline, and whether recovery is available. If recovery is supported,
approve the exact target and recovery scope and record the baseline before changing
the device. Recovery itself is recorded and verified as an action.

For a change that can strand a device on an otherwise working control path, require
one of two recovery paths. The target can restore the approved baseline on a deadline,
or the owner can verify a separate authorized route that can observe and recover the
target. For a target timer, verify it is armed before dispatch and confirm the change
only after the expected access path works. After expiry, observe the target before
reporting it restored. When neither path exists, offer guidance or diagnosis within
the supported scope.

An adapter marks a write that needs recovery with `requiresRecovery`. An
alternate-route plan binds an opaque route revision, a baseline observation from
the same task and snapshot, and a verification deadline. The action digest and
approval cover that exact plan. The runtime checks the route and baseline under its
target lease and rechecks current authority before recording dispatch. The owner
keeps the plan, path verification time, and baseline reference with the attempt.
Missing fresh readback at the deadline leaves the write outcome unknown for later
reconciliation. Paired Gateway WebSocket clients negotiate `ling.device-tasks.v4`
to display the plan and include it in the approval. Versions 1–3 present approvals
for operations without a recovery plan.

An already offline device may expose a documented setup mode. For the first BLE
recovery flow, confirm that the user can re-enter setup and that the adapter can check
the same device after provisioning. If setup ends before the result is observed, use
the supported readback path and preserve an unknown result until verification.

## 5. Failure and placement matrix

| Scenario | What can continue | Acceptance boundary |
| --- | --- | --- |
| Paired Mobile loses Gateway access | The daemon may continue work within existing approval and policy. Mobile shows last known state until it resyncs. | A client timeout neither cancels the daemon task nor dispatches it from the phone. |
| Phone-owned task loses PC assistance | Mobile can continue locally where the action's prerequisites are met. The PC retains the last projected state. | Sync resumes from the owner's journal. A missing PC artifact or proposal pauses the affected step. |
| Paired connection changes from direct to relay | The authenticated peers reconnect and resume conversation and task updates. | Replay of a message yields the recorded receipt. A transport acknowledgment cannot verify a device action. |
| Target loses its network | A healthy on-target executor can still collect local observations where supported. An independently authenticated local transport can read the target when the device exposes one. | With only the failed connection, record incomplete evidence and recover access before further writes. |
| A network change drops the control path | An approved target timer or verified alternate route can restore access. | Report the last verified outcome and require readback of the target after the change or rollback. |
| Model service is unavailable | An owning host can run local read-only checks and a versioned local playbook within its capability and approval scope. It records evidence for later analysis. | A remote approval, required capability, or observation that is unavailable pauses the affected step. |
| Target OS cannot start or target has no power | A supported, authorized recovery interface may be available when the device is powered. The ordinary OS executor depends on the OS running. | Provide guidance when there is no supported connection or recovery interface. Record that active verification could not run. |
| Standalone Mobile loses BLE or foreground execution | The phone retains its journal and observes the target after it regains access. An approved target recovery mechanism may still run. | No replay on wake or switch to the Gateway. A real accepted phone/device combination must exercise this case. |

## 6. Playbooks and evidence

An adapter normalizes measurements and executes typed actions. A versioned playbook
defines eligible device profiles, required observations, bounded branches, exit
conditions, permitted actions, and the post-action checks. Start with small checked-in
flows and fixtures. The model can select a flow, propose additional allowed
observations, and explain the result. The broker retains the authority for every action.

For the first PC diagnosis, a Windows test machine or VM has a known network fault.
Use typed reads for link and address status, gateway reachability, DNS, proxy state, and
the user's connectivity symptom. Missing or conflicting observations leave unresolved
hypotheses visible. After the diagnosis is reproducible, exercise one approved
reversible change on the test target and repeat the check that demonstrated the fault.

Treat device outputs, logs, screenshots, vendor messages, and diagnostic text as
observations. They can supply evidence when validated for the required source and
freshness. Only authenticated Ling commands and applicable policy can select a target,
change authority, or approve a task. The broker rechecks typed arguments against the
current authorized action. Redact both user-visible evidence and model inputs. Evidence
links the source and time of observation to the task, attempt, adapter version,
capability snapshot, and verification rule.

## 7. Acceptance by delivery slice

| Slice | Evidence required |
| --- | --- |
| D1 and D2 | Contract fixtures for common and incompatible versions, optional display metadata, invalid action and manifest schemas, unsupported versus denied versus offline, and dispatch after a permission change or reconnect. |
| D3 | Trace approval, dispatch intent, cancellation, timeout, unknown outcome, and subsequent observation. Include a revoke versus dispatch race and verification after a simulated link loss. Test recovery of the exact baseline when an adapter supports that behavior. |
| D4 | Read one authorized Home Assistant instance and distinguish unavailable, stale, and absent entities. Read a selected config entry and verify an approved automation re-enable against its registry ID and fresh entity readback. |
| D5 and D7 | Use repeatable Windows network fault evidence for the diagnostic branch and post-action check. Include an incomplete-data case, injected instructions in observation text, and a local read-only flow with the model service unavailable. |
| D6 | Reconnect a paired Mobile client to the same daemon task and confirm that disconnect and a duplicate command leave the owner and attempt unchanged. |
| D9 | Verify one phone restores a supported device's network through official BLE setup with no PC or Gateway. Cover denied permission, link loss and resume, and a local playbook with the model service unavailable. Record the exact phone OS, device model, firmware, and adapter version. |
| D10 | Verify project build and deploy/test/log/retest with the selected app, bound artifact and target. Exercise native tools, job reattach, and a supported vendor maintenance handoff with readback. |
| D11 | Have a paired PC assist a phone-owned task. Change the PC link and phone target separately. Verify projection, reattachment, and the owner's handling of stale or duplicate proposals. |
| D12 | Sync over direct LAN, cross-network direct, and encrypted relay paths. Verify peer trust, reconnect, revocation, and task receipt continuity through path changes. |
| D14–D15 | Resolve one shared semantic device graph and execute a parent task graph with nodes owned by different runtimes. Verify identity, twin freshness, owner leases, partial results, and recovery. |
| D16–D18 | Enroll an edge runtime, project ordered events, install a signed resource, and roll back a failed resource revision. |
| D19–D22 | Exercise physical preconditions, secret references, lifecycle changes, bounded model context, prompt-injection fixtures, trace continuity, and hardware-in-loop conformance. |

The ledger distinguishes contract fixtures, supported OS or simulator runs, and
physical device acceptance. Home Assistant exercises the shared adapter contract.
Windows exercises diagnosis and verification of a real software symptom. BLE tests
standalone phone execution. Record the result against its own slice and tested
combination.

## References

- [dsh-Go bridge contract](https://github.com/ccch1mneyyy/dsh-Go/blob/0a15d4cea9ea9a6e8b670f7c60fa50323b39f2e7/docs/design/bridge-contract.md)
  informs version negotiation, capability declarations, stale metadata, and distinct
  error cases.
- [dsh-Go phone control guide](https://github.com/ccch1mneyyy/dsh-Go/blob/0a15d4cea9ea9a6e8b670f7c60fa50323b39f2e7/docs/guide/zh/04-phone-control.md)
  informs native approval and the difference between requesting a stop and verifying
  whether an action took effect.
- [dsh-Go native plugin protocol](https://github.com/ccch1mneyyy/dsh-Go/blob/0a15d4cea9ea9a6e8b670f7c60fa50323b39f2e7/docs/design/native-plugins-protocol.md)
  informs versioned manifests and limits. Ling device adapters use the device
  capability contract and registry.

These are architectural references. Any code reuse follows the project's dependency
and license review for the relevant source.
