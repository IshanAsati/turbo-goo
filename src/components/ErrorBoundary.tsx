import { Component, type ErrorInfo, type ReactNode } from "react";

/** Keeps one broken screen from blanking the whole app. Reset by changing `resetKey` (the route). */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Screen crashed:", error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page narrow">
        <div className="empty-note" role="alert">
          <h2>This screen hit a snag.</h2>
          <p className="muted small mono">{this.state.error.message}</p>
          <div className="row">
            <button className="primary" onClick={() => this.setState({ error: null })}>Try again</button>
            <button onClick={() => (location.hash = "#/")}>Back to library</button>
          </div>
        </div>
      </div>
    );
  }
}
