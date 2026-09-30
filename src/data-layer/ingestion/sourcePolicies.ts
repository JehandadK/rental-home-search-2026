/**
 * The registered source policies. Adding a site means adding its policy file
 * and one entry here; the ingestion service looks policies up by source ID.
 */
import { niftySourcePolicy } from "./niftyPolicy";
import { athomeSourcePolicy, roomspotSourcePolicy } from "./portalPolicy";
import { SourcePolicyRegistry } from "./sourcePolicy";
import { suumoSourcePolicy } from "./suumoPolicy";

export const SOURCE_POLICIES = new SourcePolicyRegistry([
  suumoSourcePolicy,
  niftySourcePolicy,
  athomeSourcePolicy,
  roomspotSourcePolicy,
]);
