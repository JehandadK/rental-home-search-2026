/** The headed-browser page loader for AtHome / RoomSpot detail pages. */
import type { PortalDetailSource } from "../../data-layer/ingestion/contracts";
import { AthomeBrowser } from "../athome/athomeBrowser";
import { RoomspotBrowser } from "../roomspot/roomspotBrowser";
import type { PortalDetailLoader } from "./portalDetailRunner";

export function portalDetailLoader(source: PortalDetailSource): PortalDetailLoader {
  const browser = source === "athome" ? new AthomeBrowser() : new RoomspotBrowser();
  let opened = false;
  return {
    load: (url) => { opened = true; return browser.readDetail(url); },
    // Nothing to close when every page came from the capture cache.
    close: async () => { if (opened) await browser.close(); },
  };
}
