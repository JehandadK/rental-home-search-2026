/**
 * Load listings and reference data through an injected `WebDataClient`.
 *
 * Both reads start together. The result is either loading, an error the
 * user can retry, or ready data (possibly flagged stale by the client). A
 * retry, or unmounting, aborts the previous attempt so a slow, superseded
 * response can never overwrite a newer one.
 */
import { useCallback, useEffect, useState } from "react";
import type { ReadProgress, WebDataClient } from "../../data-layer/read/contracts";
import { buildReferenceModel, type ReferenceModel } from "../../domain/referenceData";
import type { EnrichedListing } from "../../domain/types";

export interface WebData {
  listings: readonly EnrichedListing[];
  reference: ReferenceModel;
  /** One message per read that was served from a stale fallback copy. */
  stale: readonly string[];
}

export type WebDataState =
  | { status: "loading"; progress?: ReadProgress }
  | { status: "error"; message: string }
  | {
      status: "ready";
      data: WebData;
      /** A retry is running; the current data stays on screen meanwhile. */
      retrying?: boolean;
      /** Why the last retry from this data failed. */
      retryError?: string;
    };

/** Progress is reported at most this often: a chunk arrives every few KB, a render is not needed for each. */
const PROGRESS_INTERVAL_MS = 100;

/** The two reads as one: bytes add up, and the total is known only when both totals are. */
function combine(parts: Map<string, ReadProgress>): ReadProgress {
  const all = [...parts.values()];
  const totals = all.map((part) => part.totalBytes);
  return {
    loadedBytes: all.reduce((sum, part) => sum + part.loadedBytes, 0),
    totalBytes: parts.size === 2 && totals.every((total) => total !== undefined)
      ? totals.reduce((sum, total) => sum! + total!, 0) : undefined,
  };
}

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
    const parts = new Map<string, ReadProgress>();
    let lastReport = 0;
    const reporter = (name: string) => (progress: ReadProgress) => {
      parts.set(name, progress);
      const now = Date.now();
      if (controller.signal.aborted || now - lastReport < PROGRESS_INTERVAL_MS) return;
      lastReport = now;
      // Only while still loading: a retry from ready data keeps its data on screen.
      setState((current) => (current.status === "loading" ? { status: "loading", progress: combine(parts) } : current));
    };
    Promise.all([
      client.queryListings({ signal: controller.signal, onProgress: reporter("listings") }),
      client.loadReferenceSnapshot({ signal: controller.signal, onProgress: reporter("reference") }),
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
