import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
import { Button } from './ui/button';
import { EmptyState } from './ui/misc';

interface State {
  error: Error | null;
}

/** Catches render errors so one broken page never blanks the whole app. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[gmi] render error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <EmptyState
        className="h-full"
        dino="idle"
        title="This page hit a snag"
        description={
          <>
            Nothing was lost. Try again, or switch pages and come back.
            {this.state.error.message ? (
              <span title={this.state.error.message} className="mt-3 line-clamp-3 block rounded-md border border-border bg-muted/60 px-2.5 py-1.5 text-left font-mono text-2xs text-muted-foreground">
                {this.state.error.message}
              </span>
            ) : null}
          </>
        }
        action={
          <Button onClick={() => this.setState({ error: null })}>
            <RotateCw /> Try again
          </Button>
        }
      />
    );
  }
}
