/** Human CLI adapter only. Agents use native browser_* tools, not this module. */
import { ChromeBridge } from "./chromeBridge";
interface Tab { id: number; title?: string; url?: string; tabFence?: string; incarnation?: string }
export class NiftyBrowser {
  private bridge = new ChromeBridge();
  private tab?: Tab;
  private sessionId = `nifty-cli-${process.pid}`;
  async connect(url: string): Promise<void> {
    await this.bridge.connect();
    const result = await this.bridge.request<{ tab: Tab }>("new_tab", { url, active: false, wait: false, sessionId: this.sessionId, turn: 1 });
    this.tab = result.tab;
    // Wait for required DOM, not analytics/advertisement page-load completion.
    await this.evaluate(`(async()=>{const end=Date.now()+20000;while(!document.querySelector('.result-bukken-table')){if(Date.now()>end)throw Error('Nifty results not ready');await new Promise(r=>setTimeout(r,200));}return true;})()`);
  }
  async evaluate<T>(expression: string): Promise<T> {
    if (!this.tab) throw new Error("No owned Nifty CLI tab");
    const result = await this.bridge.request<{ result?: { result?: { value?: T }; exceptionDetails?: { text?: string } } }>("evaluate", {
      tabId: this.tab.id, tabFence: this.tab.tabFence, incarnation: this.tab.incarnation, sessionId: this.sessionId, expression, awaitPromise: true,
    }, 35000);
    if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text ?? "Nifty page error");
    const value = result.result?.result?.value;
    if (value === undefined) throw new Error("Nifty capture returned no value");
    return value;
  }
  async close(): Promise<void> {
    if (this.tab) await this.bridge.request("close_tab", { tabId: this.tab.id, tabFence: this.tab.tabFence, incarnation: this.tab.incarnation, sessionId: this.sessionId }, 5000).catch(() => undefined);
    this.tab = undefined; this.bridge.close();
  }
}
