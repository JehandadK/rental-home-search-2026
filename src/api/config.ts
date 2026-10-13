/**
 * Server settings from flags and the environment. The API is for this machine
 * only: it has no auth layer yet, so it refuses any host but loopback.
 */
export interface ApiConfig {
  host: string;
  port: number;
  /** Directory with the published listings.json and reference.json, or an http(s) URL of one. */
  dataDir: string;
  corsOrigins: string[];
  rateLimitPerMinute: number;
}

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;

const list = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

/** True for addresses only this machine can reach. */
export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export type ConfigResult = { ok: true; config: ApiConfig } | { ok: false; error: string };

export function parseApiConfig(argv: readonly string[], env: Record<string, string | undefined>, defaultDataDir: string): ConfigResult {
  /** `--name value` or `--name=value`; a flag given without a value is an error, not a silent default. */
  const missing: string[] = [];
  const flag = (name: string) => {
    const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
    const i = argv.indexOf(`--${name}`);
    const value = inline !== undefined ? inline.slice(name.length + 3) : i >= 0 ? argv[i + 1] : undefined;
    if ((inline !== undefined || i >= 0) && (value === undefined || value === "" || value.startsWith("--"))) missing.push(`--${name}`);
    return value || undefined;
  };
  const host = flag("host") ?? env.API_HOST ?? DEFAULT_HOST;
  const dataFlag = flag("data");
  const port = Number(flag("port") ?? env.API_PORT ?? DEFAULT_PORT);
  const rateLimitPerMinute = Number(env.API_RATE_LIMIT ?? 120);
  if (missing.length) return { ok: false, error: `${missing.join(", ")} needs a value` };
  if (!Number.isInteger(port) || port < 0 || port > 65_535) return { ok: false, error: `Invalid port ${port}` };
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 0) return { ok: false, error: "API_RATE_LIMIT must be a whole number ≥ 0" };
  if (!isLoopback(host)) {
    return { ok: false, error: `Refusing to listen on ${host}: the API has no auth layer yet, so it serves this machine only (use a loopback host)` };
  }
  const dataDir = dataFlag ?? env.API_DATA ?? defaultDataDir;
  // Anything with a scheme (two or more letters, so "C:" stays a path) is a URL and must be a plain http(s) one.
  if (/^[a-z][a-z0-9+.-]+:/i.test(dataDir)) {
    let url: URL;
    try {
      url = new URL(dataDir);
    } catch {
      return { ok: false, error: "API_DATA is not a valid URL" };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: `API_DATA must be a directory or an http(s) URL, not ${url.protocol}` };
    if (!/^https?:\/\//i.test(dataDir)) return { ok: false, error: "API_DATA is not a valid URL (expected http(s)://…)" };
    if (url.username || url.password || url.search || url.hash) {
      return { ok: false, error: "API_DATA may not carry credentials, a query or a fragment; serve the files at a plain URL" };
    }
  }
  return {
    ok: true,
    config: { host, port, dataDir, corsOrigins: list(env.API_CORS_ORIGINS), rateLimitPerMinute },
  };
}
