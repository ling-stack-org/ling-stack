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

export const LazyThreadPage = lazy(() =>
  import("../features/runs/ThreadPage.js").then((module) => ({
    default: module.ThreadPage,
  })),
);

export const LazyAutomationsPage = lazy(() =>
  import("../features/automations/AutomationsPage.js").then((module) => ({
    default: module.AutomationsPage,
  })),
);

export const LazySettingsPage = lazy(() =>
  import("../features/settings/SettingsPage.js").then((module) => ({
    default: module.SettingsPage,
  })),
);

export const LazyProfilePage = lazy(() =>
  import("../features/profile/ProfilePage.js").then((module) => ({
    default: module.ProfilePage,
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

export const LazyGlobalWorkBoardPage = lazy(() =>
  import("../features/work-board/GlobalWorkBoardPage.js").then((module) => ({
    default: module.GlobalWorkBoardPage,
  })),
);

export const LazyMediaJobsPage = lazy(() =>
  import("../features/media/MediaJobsPage.js").then((module) => ({
    default: module.MediaJobsPage,
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
