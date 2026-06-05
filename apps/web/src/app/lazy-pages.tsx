import { Component, lazy, type ErrorInfo, type ReactNode } from "react";

export const LazyWorkspaceClientView = lazy(() =>
  import("../features/workspace/WorkspaceClientView.js").then((module) => ({
    default: module.WorkspaceClientView,
  })),
);

export const LazyRunHistory = lazy(() =>
  import("../features/runs/RunHistory.js").then((module) => ({
    default: module.RunHistory,
  })),
);

export const LazySettingsPage = lazy(() =>
  import("../features/settings/SettingsPage.js").then((module) => ({
    default: module.SettingsPage,
  })),
);

export const LazyAiTeammatesPage = lazy(() =>
  import("../features/teammates/AiTeammatesPage.js").then((module) => ({
    default: module.AiTeammatesPage,
  })),
);

export const LazyTeammateWorkspace = lazy(() =>
  import("../features/teammates/TeammateWorkspace.js").then((module) => ({
    default: module.TeammateWorkspace,
  })),
);

export const LazyProviderSettings = lazy(() =>
  import("../features/providers/ProviderSettings.js").then((module) => ({
    default: module.ProviderSettings,
  })),
);

export const LazyApprovalsPage = lazy(() =>
  import("../features/approvals/ApprovalsPage.js").then((module) => ({
    default: module.ApprovalsPage,
  })),
);

export const LazyMediaJobsPage = lazy(() =>
  import("../features/media/MediaJobsPage.js").then((module) => ({
    default: module.MediaJobsPage,
  })),
);

export const LazyMcpToolsPage = lazy(() =>
  import("../features/mcp/McpToolsPage.js").then((module) => ({
    default: module.McpToolsPage,
  })),
);

interface LazyPageErrorBoundaryProps {
  readonly children: ReactNode;
  readonly resetKey: string;
  readonly title: string;
  readonly retryLabel: string;
}

interface LazyPageErrorBoundaryState {
  readonly error: Error | undefined;
}

export class LazyPageErrorBoundary extends Component<LazyPageErrorBoundaryProps, LazyPageErrorBoundaryState> {
  state: LazyPageErrorBoundaryState = { error: undefined };

  static getDerivedStateFromError(error: Error): LazyPageErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(previousProps: LazyPageErrorBoundaryProps): void {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: undefined });
    }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("Lazy page chunk failed", error, errorInfo);
  }

  render(): ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="client-empty-state">
        <span>{this.props.title}</span>
        <small>{this.state.error.message}</small>
        <button className="secondary-button compact-button" type="button" onClick={() => window.location.reload()}>
          {this.props.retryLabel}
        </button>
      </div>
    );
  }
}
