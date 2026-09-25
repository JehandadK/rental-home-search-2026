import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileLockTimeoutError, withFileLock, writeJsonAtomically } from "./jsonFile";

const roots: string[] = [];

async function tempDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rental-data-store-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("JSON filesystem primitives", () => {
  it("serializes concurrent operations on the same path", async () => {
    const dir = await tempDirectory();
    const target = join(dir, "records.json");
    let active = 0;
    let maximumActive = 0;
    const operation = () => withFileLock(target, async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active--;
    });

    await Promise.all([operation(), operation(), operation()]);

    expect(maximumActive).toBe(1);
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it("writes valid JSON via unique temp files and leaves no lock/temp artifacts", async () => {
    const dir = await tempDirectory();
    const target = join(dir, "records.json");
    await Promise.all(
      Array.from({ length: 8 }, (_, value) => writeJsonAtomically(target, { value })),
    );

    const result = JSON.parse(await readFile(target, "utf8")) as { value: number };
    expect(result.value).toBeGreaterThanOrEqual(0);
    expect(result.value).toBeLessThan(8);
    await expect(readdir(dir)).resolves.toEqual(["records.json"]);
  });

  it("keeps the last committed file intact when serialization fails", async () => {
    const dir = await tempDirectory();
    const target = join(dir, "records.json");
    await writeFile(target, '{"value":"committed"}\n', "utf8");
    const circular: { self?: unknown } = {};
    circular.self = circular;

    await expect(writeJsonAtomically(target, circular)).rejects.toThrow();
    await expect(readFile(target, "utf8")).resolves.toBe('{"value":"committed"}\n');
    await expect(readdir(dir)).resolves.toEqual(["records.json"]);
  });

  it("does not automatically break a lock whose owner may still be active", async () => {
    const dir = await tempDirectory();
    const target = join(dir, "records.json");
    const lockPath = `${target}.lock`;
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: "now" }), "utf8");

    await expect(
      withFileLock(target, async () => undefined, { timeoutMs: 30, pollMs: 5 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
    await expect(readFile(lockPath, "utf8")).resolves.toContain(String(process.pid));
  });
});
