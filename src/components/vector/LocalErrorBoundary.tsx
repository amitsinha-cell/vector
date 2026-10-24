import React, { Component, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface LocalErrorBoundaryProps {
  children: ReactNode;
  name?: string;
  fallbackTitle?: string;
  fallbackMessage?: string;
  onReset?: () => void;
}

interface LocalErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class LocalErrorBoundary extends Component<
  LocalErrorBoundaryProps,
  LocalErrorBoundaryState
> {
  constructor(props: LocalErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): LocalErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(
      `[LocalErrorBoundary${this.props.name ? `:${this.props.name}` : ""}] caught error:`,
      error,
      errorInfo,
    );
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  override render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-left shadow-sm">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <h4 className="text-xs font-semibold">
              {this.props.fallbackTitle || `Error in ${this.props.name || "component"}`}
            </h4>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {this.props.fallbackMessage ||
              "An unexpected error occurred while rendering this section."}
          </p>
          {import.meta.env.DEV && this.state.error && (
            <p className="mt-2 font-mono text-[11px] text-destructive/90 break-all">
              {this.state.error.message}
            </p>
          )}
          <button
            onClick={this.reset}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
