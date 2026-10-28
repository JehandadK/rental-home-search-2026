/**
 * Opens the shared portal browser and keeps it open until Ctrl+C, for collectors
 * run outside `npm run refresh` (which opens its own for the run).
 *
 *   npm run browser                     profile .context/browser-profile
 *   PLAYWRIGHT_USER_DATA_DIR=… npm run browser
 *
 * Then, in another terminal: PLAYWRIGHT_CDP_URL=<printed url> npm run scrape:athome …
 */
import { openSharedBrowser } from "../src/collectors/shared/sharedBrowser";

const browser = await openSharedBrowser();
console.log(`Shared browser on profile ${browser.userDataDir}`);
console.log(`PLAYWRIGHT_CDP_URL=${browser.cdpUrl}`);
const shutdown = async () => {
  await browser.close().catch(() => undefined);
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
