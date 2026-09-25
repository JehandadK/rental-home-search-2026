/** List-first Nifty discovery. Zero mandatory detail requests; per-page checkpoints. */
import { NiftyBrowser } from "./lib/niftyBrowser";
import { niftyCaptureExpression } from "./lib/niftyCapture";
import { parseNiftyPage, niftyMatchKeys, mergeNiftyIncremental } from "./lib/nifty";
import { cachedPage } from "./lib/captureStore";
import { readSource, writeSource } from "./lib/dataStore";
import { trackingKey } from "./lib/lifecycle";
import { DEFAULT_INCREMENTAL_PAGE_CEILING, positiveInteger } from "./lib/refreshPlan";

const args = process.argv.slice(2);
const arg = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const slug = arg("--city") ?? "sokashi_ct";
const cities: Record<string, string> = { sokashi_ct: "Soka", koshigayashi_ct: "Koshigaya", kawaguchishi_ct: "Kawaguchi" };
if (!cities[slug]) throw new Error("Unknown Nifty city");
const limit = positiveInteger(arg("--pages"), DEFAULT_INCREMENTAL_PAGE_CEILING);
const deep = args.includes("--deep");
const urlFor = (page: number) => `https://myhome.nifty.com/rent/saitama/${slug}/${page > 1 ? page + "/" : ""}?sort=regDate-desc`;
const browser = new NiftyBrowser();
let connected = false, knownPages = 0, totalAdded = 0, pages = 0;
try {
  for (let page = 1; page <= limit; page++) {
    const capture = await cachedPage({ source: "nifty", city: cities[slug], url: urlFor(page), page }, async () => {
      if (!connected) { await browser.connect(urlFor(page)); connected = true; }
      return browser.evaluate<string>(niftyCaptureExpression(urlFor(page)));
    });
    const previous = await readSource("nifty");
    const parsed = parseNiftyPage(capture.html, cities[slug], new Date(capture.capturedAt).getFullYear());
    const known = new Set((previous?.listings ?? []).flatMap(niftyMatchKeys));
    const novel = parsed.filter((l) => !niftyMatchKeys(l).some((k) => known.has(k))).length;
    const merged = mergeNiftyIncremental(previous?.listings ?? [], parsed);
    const times = { ...(previous?.provenance?.observedAtByKey as Record<string, string> ?? {}) };
    for (const l of parsed) times[trackingKey(l)] = capture.capturedAt;
    await writeSource({ source: "nifty", scrapedAt: capture.capturedAt, completeSnapshot: false,
      provenance: { ...previous?.provenance, mode: "verified newest-first list discovery", capturedBy: "scripts/crawl-nifty.ts", observedTrackingKeys: parsed.map(trackingKey), observedAtByKey: times }, listings: merged.listings });
    totalAdded += merged.added; pages++;
    knownPages = parsed.length > 0 && novel === 0 ? knownPages + 1 : 0;
    if (!deep && knownPages >= 2) break;
    if (page < limit) await new Promise((r) => setTimeout(r, 2500));
  }
  console.log(`Discovered ${totalAdded} new; ${pages} list pages; 0 detail loads; source checkpointed after each page.`);
} catch (e) {
  console.error(`Nifty stopped (validated progress retained): ${(e as Error).message}`); process.exitCode = 2;
} finally { await browser.close(); }
