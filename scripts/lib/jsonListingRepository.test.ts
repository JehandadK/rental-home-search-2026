import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSourceStore } from "./dataStore";
import { JsonListingRepository } from "./jsonListingRepository";
import { defineListingRepositoryContract } from "./listingRepository.contract";

defineListingRepositoryContract("JSON files", async () => {
  const root = await mkdtemp(join(tmpdir(), "listing-repository-contract-"));
  const sourceStore = new JsonSourceStore(join(root, "sources"), join(root, "backups"));
  return {
    repository: new JsonListingRepository(sourceStore),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
});
