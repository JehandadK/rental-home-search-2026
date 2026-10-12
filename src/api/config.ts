/**
 * Server settings from flags and the environment. Local by default; anything
 * reachable from another machine must have bearer tokens.
 */
export interface ApiConfig {
  host: string;
  port: number;
  /** Directory with the published listings.json and reference.json. */
  dataDir: string;
  tokens: string[];
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
  /** `--name value` or `--name=value`. */
  const flag = (name: string) => {
    const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const host = flag("host") ?? env.API_HOST ?? DEFAULT_HOST;
  const port = Number(flag("port") ?? env.API_PORT ?? DEFAULT_PORT);
  const rateLimitPerMinute = Number(env.API_RATE_LIMIT ?? 120);
  const tokens = list(env.API_TOKENS);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) return { ok: false, error: `Invalid port ${port}` };
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 0) return { ok: false, error: "API_RATE_LIMIT must be a whole number ≥ 0" };
  if (tokens.some((token) => token.length < 16 || new Set(token).size < 8 || /\s/.test(token))) {
    return { ok: false, error: "Every API_TOKENS entry must be at least 16 characters, with at least 8 different ones and no spaces (e.g. openssl rand -hex 24)" };
  }
  if (!isLoopback(host) && tokens.length === 0) {
    return { ok: false, error: `Refusing to listen on ${host} without API_TOKENS: only loopback hosts may run without auth` };
  }
  return {
    ok: true,
    config: { host, port, dataDir: flag("data") ?? env.API_DATA ?? defaultDataDir, tokens, corsOrigins: list(env.API_CORS_ORIGINS), rateLimitPerMinute },
  };
}
