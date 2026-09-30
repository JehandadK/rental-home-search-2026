/** Where the persisted data files live. The only place that knows. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Root of the persisted data files. */
export const DATA_DIR = join(REPO_ROOT, "data");

/**
 * Derived files the web app fetches at runtime (`npm run data:web`). Vite
 * serves `public/` in dev and copies it into `dist/`, so only files meant
 * for the browser belong here — never sources, captures, or backups.
 */
export const WEB_PUBLISH_DIR = join(REPO_ROOT, "public", "data");
