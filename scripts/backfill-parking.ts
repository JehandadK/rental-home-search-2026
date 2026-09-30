/** Compatibility alias: one optional detail fetch now captures ALL useful fields. */
export { parseParking, extractParkingCell, type ParkingInfo } from "../src/collectors/shared/parking";
import { enrichDetails } from "./enrich-details";
if (process.argv[1]?.endsWith("backfill-parking.ts")) {
  enrichDetails().catch((e) => { console.error((e as Error).message); process.exitCode = 1; });
}
