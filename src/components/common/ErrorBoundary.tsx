/**
 * A render error stops at the nearest boundary, not at the window (1.0.1).
 *
 * React unmounts the whole tree when a render throws and nothing catches it,
 * which is how one settings field left `undefined` by an old saved blob turned
 * into "the app crashed" — a blank window, no message, and no way back short of
 * a restart. A boundary around each screen keeps the failure the size it
 * actually is, and shows the error, because the first thing anyone needs is
 * what went wrong.
 */
import React from "react";
import { AlertTriangle } from "lucide-react";

type Props = {
  children: React.ReactNode;
  /** Named in the message, so "Chat settings" beats "something". */
  label?: string;
  /** Changing this remounts the children — a tab id, so leaving and coming
   * back is a real retry rather than the same broken render. */
  resetKey?: unknown;
};

type State = { error: Error | null };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`render failed${this.props.label ? ` in ${this.props.label}` : ""}`, error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="m-auto flex max-w-md flex-col items-center gap-3 p-6 text-center">
        <AlertTriangle size={20} className="text-amber-500" />
        <div className="text-sm font-medium">
          {this.props.label ? `${this.props.label} failed to open` : "Something failed to render"}
        </div>
        <p className="text-xs text-[var(--color-text-muted)]">
          The rest of the app is unaffected. If this keeps happening, the message below is the
          thing to report.
        </p>
        <pre className="max-h-40 w-full overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-panel)] p-2 text-left font-mono text-[11px] text-[var(--color-text-muted)]">
          {error.message || String(error)}
        </pre>
        <button
          onClick={() => this.setState({ error: null })}
          className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          Try again
        </button>
      </div>
    );
  }
}
