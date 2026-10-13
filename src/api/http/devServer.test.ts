import { describe, expect, it } from "vitest";
import config from "../../../vite.config";
import { createDevApi, DEV_MOUNT_PATH } from "./devServer";

describe("the API in the website's dev server", () => {
  it("is part of the Vite config, mounted at /api", () => {
    const plugins = (config.plugins ?? []).flat().filter((plugin): plugin is { name: string } => !!plugin && typeof plugin === "object" && "name" in plugin);
    expect(plugins.map((plugin) => plugin.name)).toContain("recommendations-api");
    expect(DEV_MOUNT_PATH).toBe("/api");
  });

  it("stays out of the way when its settings are wrong, so the site still starts", async () => {
    const lines: string[] = [];
    const api = await createDevApi({ dataDir: "/nowhere", env: { API_RATE_LIMIT: "-1" }, log: (line) => lines.push(line) });
    expect(api).toBeNull();
    expect(lines[0]).toMatch(/not mounted: .*API_RATE_LIMIT/);
  });

  it("starts without waiting for the data, which loads in the background", async () => {
    const lines: string[] = [];
    const started = Date.now();
    const api = await createDevApi({ dataDir: "/nowhere", env: {}, log: (line) => lines.push(line) });
    expect(api).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    api!.close();
  });
});
