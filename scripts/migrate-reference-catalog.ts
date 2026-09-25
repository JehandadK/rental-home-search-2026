import { resolve } from "node:path";
import { JsonReferenceDataRepository } from "./lib/jsonReferenceDataRepository";
import { DATA_DIR } from "./lib/dataStore";

const directory = resolve(DATA_DIR, "../../data/reference/v1");
const result = await new JsonReferenceDataRepository(directory).upgradePersistedSchemas();
if (result.upgraded.length === 0 && !result.formatUpgraded) {
  console.log(`Reference catalog format/schema is current: ${directory}`);
} else {
  console.log(`Upgraded reference datasets: ${result.upgraded.join(", ") || "none"}`);
  if (result.formatUpgraded) console.log("Updated the catalog revision algorithm to include dataset schema versions.");
  console.log(`New catalog revision: ${result.revision}`);
  console.log("Previous dataset files and manifest checkpoints were retained for rollback.");
}
