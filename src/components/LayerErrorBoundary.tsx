import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /**
   * What broke, in the user's language — "Connections", "Browser cards".
   * Shown in the badge and written to the log, so it has to be recognisable
   * on screen and greppable afterwards.
   */
  name: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Contains a render crash to one part of the canvas.
 *
 * The app has exactly one boundary otherwise, at the root (src/main.tsx), and
 * React unmounts up to the *nearest* boundary — so with only a root one, the
 * nearest is always the root and the blast radius is always the entire app. A
 * stale variable in the connection overlay took out every terminal, card and
 * toolbar on screen twice during one editing session: trivial cause, total
 * symptom. That asymmetry is what this fixes.
 *
 * Deliberately quiet. A failed overlay renders a small corner badge instead of
 * a full-screen takeover, because the point is that everything *else* keeps
 * working — a modal saying "something went wrong" over a canvas that is fine
 * would recreate the problem it exists to solve. The root boundary still
 * catches anything outside these seams.
 *
 * Retry remounts the subtree. Worth offering because these failures are
 * usually transient (a hot reload mid-edit, a store briefly out of step), and
 * a remount is free next to reloading the window — which restarts every PTY.
 */
export class LayerErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // console.error rather than warn: the dev-log forwarder only picks up
    // renderer console levels >= 2, and this must reach the log file the user
    // sends back when a crash happens on a machine I can't see.
    console.error(
      `[LayerErrorBoundary] ${this.props.name} failed:`,
      error,
      info.componentStack,
    );
    // Lands in render-diagnostics.jsonl, which is the file to ask for when
    // this happens on a machine I can't reach.
    void window.termcanvas?.diagnostics
      ?.recordRenderEvent?.({
        kind: "layer-error",
        data: {
          layer: this.props.name,
          message: error.message,
          stack: error.stack?.split("\n").slice(0, 8).join("\n"),
        },
      })
      // Diagnostics are best-effort; a failure here must never escalate into
      // a second error raised inside an error handler.
      .catch(() => {});
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="absolute bottom-3 left-3 z-[60] pointer-events-auto">
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border border-[var(--red)]/30 bg-[var(--surface)] px-2.5 py-1.5 shadow-lg"
          style={{ fontFamily: '"Geist Mono", monospace' }}
        >
          <span className="text-[11px] text-[var(--red)]">
            {this.props.name} stopped drawing
          </span>
          <button
            type="button"
            onClick={this.handleRetry}
            className="text-[11px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors duration-quick"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
}
