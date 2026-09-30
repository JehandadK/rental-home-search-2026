/**
 * Hand-made availability marks for individual portal ads ("I opened this link
 * and it says the room is gone"). Browser-local like the decision marks; the
 * checker's published results arrive with the listing data instead.
 */
import { useCallback } from "react";
import { adKey, type AvailabilityMap } from "../../domain/availability";
import type { SourceListingReference } from "../../domain/types";
import { decodeAvailabilityMarks } from "../userState/decoders";
import { USER_STATE_KEYS } from "../userState/store";
import { usePersistentState } from "../userState/UserStateContext";

export function useAvailabilityMarks() {
  const [availabilityMarks, setMarks] = usePersistentState<AvailabilityMap>(USER_STATE_KEYS.availabilityMarks, decodeAvailabilityMarks);

  /** Record that this portal ad is now gone or still listed, as of now. */
  const markAd = useCallback((ad: SourceListingReference, state: "gone" | "listed") => {
    const url = ad.url;
    if (!url) return;
    setMarks((current) => ({
      ...current,
      [adKey(ad.source, url, ad.id)]: {
        source: ad.source, url, state, checkedAt: new Date().toISOString(),
        evidence: state === "gone" ? "marked gone by hand" : "marked still listed by hand", method: "manual",
      },
    }));
  }, [setMarks]);

  return { availabilityMarks, markAd };
}
