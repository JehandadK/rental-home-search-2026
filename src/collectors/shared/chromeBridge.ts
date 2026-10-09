import { PlaywrightBridge } from "./playwrightBridge";
/** Minimal read-only client for the local Pi Control Chrome Bridge. */
const HOST = process.env.PI_CONTROL_CHROME_BRIDGE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PI_CONTROL_CHROME_BRIDGE_PORT ?? 17318);
const HTTP = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}/ws`;

interface BridgeTarget {
  browserId: string;
  connectionId?: string;
  connectionGeneration?: number;
}

export class ChromeBridge {
  private socket?: WebSocket;
  private sequence = 0;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private target?: BridgeTarget;

  async connect(): Promise<void> {
    const pair = (await (await fetch(`${HTTP}/pair`)).json()) as { token?: string };
    if (!pair.token) throw new Error("Pi Control Chrome Bridge is unavailable. Run /chrome connect first.");
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`${WS}?role=pi&token=${encodeURIComponent(pair.token!)}`);
      this.socket = socket;
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Could not connect to Pi Control Chrome Bridge")), { once: true });
      socket.addEventListener("message", (event) => this.onMessage(String(event.data)));
    });
    const status = (await this.raw("status", {}, undefined)) as { browserId?: string; connectionId?: string; connectionGeneration?: number };
    if (!status.browserId) throw new Error("Chrome extension is not connected. Run /chrome connect first.");
    this.target = {
      browserId: status.browserId,
      connectionId: status.connectionId,
      connectionGeneration: status.connectionGeneration,
    };
  }

  close(): void {
    this.socket?.close();
  }

  request<T>(method: string, params: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
    return this.raw(method, params, this.target, timeoutMs) as Promise<T>;
  }

  get browserId(): string {
    if (!this.target) throw new Error("Bridge is not connected");
    return this.target.browserId;
  }

  private raw(method: string, params: Record<string, unknown>, target?: BridgeTarget, timeoutMs = 30_000): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Bridge is disconnected"));
    const id = `athome-${process.pid}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try { this.socket?.send(JSON.stringify({ type: "cancel", id })); } catch { /* noop */ }
        reject(new Error(`Browser request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ type: "request", id, method, params, ...(target ? { target } : {}) }));
    });
  }

  private onMessage(raw: string): void {
    let message: { type?: string; id?: string; result?: unknown; error?: { message?: string; code?: string } };
    try { message = JSON.parse(raw); } catch { return; }
    if (message.type !== "response" || !message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message ?? "Browser Bridge error");
      (error as Error & { code?: string }).code = message.error.code;
      pending.reject(error);
    } else pending.resolve(message.result);
  }
}

/** Minimal surface the portal browser adapters need from a browser driver. */
export interface BrowserBridge {
  connect(): Promise<void>;
  request<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  close(): void;
}

/** ChromeBridge by default; BROWSER_DRIVER=playwright launches a local Playwright Chromium instead. */
export function createBridge(): BrowserBridge {
  return process.env.BROWSER_DRIVER === "playwright" ? new PlaywrightBridge() : new ChromeBridge();
}
