/**
 * The app's data boundary: nothing below it renders until listings and
 * reference data have loaded. It shows an explicit loading state, an error
 * with a retry, and notices for stale or empty data.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import type { WebDataClient } from "../../data-layer/read/contracts";
import { useWebData, type WebData } from "./useWebData";
import styles from "./WebDataBoundary.module.css";

interface Props {
  client: WebDataClient;
  children: (data: WebData) => ReactNode;
}

export function WebDataBoundary({ client, children }: Props) {
  const { state, retry } = useWebData(client);

  if (state.status === "loading") {
    return (
      <div className={styles.state} role="status">
        Loading listings and reference data…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className={styles.state} role="alert">
        <p>Could not load the listing data: {state.message}</p>
        <button type="button" onClick={retry}>
          Retry
        </button>
      </div>
    );
  }

  const { data } = state;
  const notices: ReactNode[] = [];
  if (data.stale.length > 0) {
    notices.push(
      <div key="stale" className={styles.notice} role="status">
        Showing an older copy of the data. {data.stale.join(" · ")}
        {state.retryError && <span> · Retry failed: {state.retryError}</span>}
        <button type="button" className="secondary" onClick={retry} disabled={state.retrying}>
          {state.retrying ? "Retrying…" : "Retry"}
        </button>
      </div>,
    );
  }
  if (data.listings.length === 0) {
    notices.push(
      <div key="no-listings" className={styles.notice} role="status">
        No listings have been published yet. Run <code>npm run data:web</code>, or add a listing by hand.
      </div>,
    );
  }
  if (data.reference.catalog.places.length === 0 && data.reference.boundaries.length === 0) {
    notices.push(
      <div key="no-reference" className={styles.notice} role="status">
        The reference catalog is empty, so there are no places to measure distances to.
      </div>,
    );
  }
  return (
    <>
      {notices}
      <RenderErrorBoundary>{children(data)}</RenderErrorBoundary>
    </>
  );
}

/**
 * Loaded data that passes the client's checks can still hold a record the
 * app cannot draw. Show that as an error instead of a blank page.
 */
class RenderErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("The app could not render the loaded data", error, info.componentStack);
  }

  render() {
    if (this.state.message == null) return this.props.children;
    return (
      <div className={styles.state} role="alert">
        <p>The app could not display the loaded data: {this.state.message}</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
