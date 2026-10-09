import { JsonReferenceDataRepository } from "../src/storage/json/jsonReferenceDataRepository";
import { REFERENCE_CATALOG_DIR } from "../src/storage/json/dataStore";

const directory = REFERENCE_CATALOG_DIR;
const result = await new JsonReferenceDataRepository(directory).upgradePersistedSchemas();
if (result.upgraded.length === 0 && !result.formatUpgraded) {
  console.log(`Reference catalog format/schema is current: ${directory}`);
} else {
  console.log(`Upgraded reference datasets: ${result.upgraded.join(", ") || "none"}`);
  if (result.formatUpgraded) console.log("Updated the catalog revision algorithm to include dataset schema versions.");
  console.log(`New catalog revision: ${result.revision}`);
  console.log("Previous dataset files and manifest checkpoints were retained for rollback.");
}
