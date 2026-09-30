/**
 * Load listings and reference data through an injected `WebDataClient`.
 *
 * Both reads start together. The result is either loading, an error the
 * user can retry, or ready data (possibly flagged stale by the client). A
 * retry, or unmounting, aborts the previous attempt so a slow, superseded
 * response can never overwrite a newer one.
 */
import { useCallback, useEffect, useState } from "react";
import type { WebDataClient } from "../../data-layer/read/contracts";
import { buildReferenceModel, type ReferenceModel } from "../../domain/referenceData";
import type { EnrichedListing } from "../../domain/types";

export interface WebData {
  listings: readonly EnrichedListing[];
  reference: ReferenceModel;
  /** One message per read that was served from a stale fallback copy. */
  stale: readonly string[];
}

export type WebDataState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      data: WebData;
      /** A retry is running; the current data stays on screen meanwhile. */
      retrying?: boolean;
      /** Why the last retry from this data failed. */
      retryError?: string;
    };

export function useWebData(client: WebDataClient): { state: WebDataState; retry: () => void } {
  const [state, setState] = useState<WebDataState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    // A retry from a ready (stale) state keeps the current data on screen
    // until the new data arrives, and keeps it if the retry fails too.
    setState((current) => (current.status === "ready"
      ? (attempt > 0 ? { ...current, retrying: true, retryError: undefined } : current)
      : { status: "loading" }));
    Promise.all([
      client.queryListings({ signal: controller.signal }),
      client.loadReferenceSnapshot({ signal: controller.signal }),
    ])
      .then(([listings, reference]): WebData => ({
        listings: listings.data.listings,
        reference: buildReferenceModel(reference.data),
        stale: [
          listings.stale && `Listings: ${listings.stale.reason}`,
          reference.stale && `Reference data: ${reference.stale.reason}`,
        ].filter((message): message is string => Boolean(message)),
      }))
      .then(
        (data) => {
          if (!controller.signal.aborted) setState({ status: "ready", data });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          const message = error instanceof Error ? error.message : String(error);
          setState((current) => (current.status === "ready"
            ? { ...current, retrying: false, retryError: message }
            : { status: "error", message }));
        },
      );
    return () => controller.abort();
  }, [client, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}
