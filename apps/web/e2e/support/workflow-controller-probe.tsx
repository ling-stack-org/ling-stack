import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useMediaWorkflowController } from "../../src/features/media-production/workflows/use-media-workflow-controller.js";

/** Mount through Vite so the probe and the controller share one React instance. */
export function mountWorkflowControllerProbe(): void {
  const host = document.createElement("div");
  host.id = "workflow-controller-probe";
  document.body.append(host);

  function Probe(): React.JSX.Element {
    const [cwdValue, setCwdValue] = useState("/cwd-a");
    const controller = useMediaWorkflowController({ cwd: cwdValue, onJobsChanged: () => undefined });
    return React.createElement("section", {},
      React.createElement("button", { id: "workflow-probe-switch", onClick: () => setCwdValue("/cwd-b") }, "Switch cwd"),
      React.createElement("pre", { id: "workflow-probe-state" }, JSON.stringify({
        cwd: cwdValue,
        phase: controller.state.phase,
        connections: controller.state.connections.map((item) => item.name),
      })),
    );
  }

  createRoot(host).render(React.createElement(Probe));
}
