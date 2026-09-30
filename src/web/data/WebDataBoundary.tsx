/**
 * The app's data boundary: nothing below it renders until listings and
 * reference data have loaded. It shows an explicit loading state, an error
 * with a retry, and notices for stale or empty data.
 */
import type { ReactNode } from "react";
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
        <button type="button" className="secondary" onClick={retry}>
          Retry
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
      {children(data)}
    </>
  );
}
