/** Root of the persisted data files. The only place that knows where they live. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
