import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { useApprovalsDomain } from "../../src/domains/approvals/use-approvals-domain.js";
import type { DomainEvent } from "../../src/app/domain-events.js";

/** Production domain actions with controlled transport, without an execution engine. */
export function mountApprovalsDomainFixture(options: {
  readonly refreshOnSwitch?: boolean;
  readonly failResolutionRefresh?: boolean;
} = {}) {
  const container = document.createElement("main");
  document.body.append(container);
  const root = createRoot(container);
  function Fixture() {
    const [cwd, setCwd] = useState("/p2/workspace-a");
    const [completed, setCompleted] = useState(0);
    const [completedLoads, setCompletedLoads] = useState(0);
    const [events, setEvents] = useState<readonly DomainEvent[]>([]);
    const loaded = useRef(false);
    const domain = useApprovalsDomain({ cwd, emitEvent: async event => {
      if (options.failResolutionRefresh) throw new Error("Resolution refresh failed");
      setEvents(current => [...current, event]);
    } });
    function refresh(workspaceCwd: string) {
      void domain.actions.refreshApprovals(workspaceCwd).finally(() => setCompletedLoads(current => current + 1));
    }
    useEffect(() => {
      if (!loaded.current || options.refreshOnSwitch !== false) refresh(cwd);
      loaded.current = true;
    }, [cwd]);
    return <>
      <button onClick={() => setCwd("/p2/workspace-a")}>Workspace A</button>
      <button onClick={() => setCwd("/p2/workspace-b")}>Workspace B</button>
      <button onClick={() => {
        refresh("/p2/workspace-b");
        setCwd("/p2/workspace-b");
      }}>Load workspace B</button>
      <button onClick={() => domain.actions.resetForCwd()}>Reset workspace</button>
      <button onClick={() => refresh(cwd)}>Refresh approvals</button>
      <button disabled={Boolean(domain.state.resolvingApprovals.approval)} onClick={() => {
        void domain.actions.resolveApproval("approval", "approve_once")
          .finally(() => setCompleted(current => current + 1));
      }}>Allow once</button>
      <output aria-label="Workspace">{cwd}</output>
      <output aria-label="Approval status">{domain.state.approvals.find(item => item.id === "approval")?.status ?? "none"}</output>
      <output aria-label="Approval error">{domain.state.approvalErrors.approval ?? ""}</output>
      <output aria-label="Completed decisions">{completed}</output>
      <output aria-label="Completed loads">{completedLoads}</output>
      <output aria-label="Resolved events">{events.length}</output>
      <output aria-label="Reconciliation pending">{String(events.some(event => event.type === "approval.resolved" && event.reconciliationPending))}</output>
      <output aria-label="Load error">{domain.error?.message ?? ""}</output>
    </>;
  }
  root.render(<Fixture />);
  return { dispose: () => { root.unmount(); container.remove(); } };
}
