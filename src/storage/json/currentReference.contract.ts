/** Test harness: the checked-in managed reference catalog as the app's reference model. */
import { buildReferenceModel, type ReferenceModel } from "../../domain/referenceData";
import { REFERENCE_CATALOG_DIR } from "./dataStore";
import { JsonReferenceDataRepository } from "./jsonReferenceDataRepository";

export async function loadCurrentReferenceModel(): Promise<ReferenceModel> {
  return buildReferenceModel(await new JsonReferenceDataRepository(REFERENCE_CATALOG_DIR).loadSnapshot());
}
