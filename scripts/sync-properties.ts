/**
 * Fold every current data file into the property documents (data/properties/).
 *
 *   npm run data:properties
 *
 * Additive and idempotent: it only ever adds values, sightings and events, so
 * it is safe to run at any time. `data:build`, `check:availability` and
 * `data:journal:compact` run it automatically.
 */
import { describePropertySync } from "../src/data-layer/properties/service";
import { PROPERTIES_DIR } from "../src/storage/json/propertyDocumentStore";
import { syncCurrentProperties } from "../src/storage/json/propertyEvidence";

syncCurrentProperties("data:properties")
  .then((report) => console.log(`${describePropertySync(report)}\n  ${PROPERTIES_DIR}`))
  .catch((error) => { console.error(error); process.exit(1); });
