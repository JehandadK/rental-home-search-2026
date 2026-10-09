import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface FileLockMetadata {
  token: string;
  pid: number;
  acquiredAt: string;
}

export class FileLockTimeoutError extends Error {
  constructor(readonly lockPath: string, readonly owner?: Partial<FileLockMetadata>) {
    const detail = owner?.pid
      ? ` Lock owner PID ${owner.pid}, acquired ${owner.acquiredAt ?? "at an unknown time"}.`
      : " Lock metadata is missing or unreadable.";
    super(
      `Timed out waiting for ${lockPath}.${detail} Verify that no writer is active before manually removing a stale lock.`,
    );
    this.name = "FileLockTimeoutError";
  }
}

/**
 * Serialize operations on one local filesystem path using exclusive lock-file
 * creation. Locks are deliberately not auto-broken: stale-lock recovery must
 * be an operator decision after confirming the owner is no longer running.
 */
export async function withFileLock<T>(
  targetPath: string,
  operation: () => Promise<T>,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 25;
  await mkdir(dirname(lockPath), { recursive: true });

  const metadata: FileLockMetadata = {
    token: randomUUID(),
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  const startedAt = Date.now();
  let handle;

  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new FileLockTimeoutError(lockPath, await readLockMetadata(lockPath));
      }
      await delay(Math.min(pollMs, Math.max(1, timeoutMs - (Date.now() - startedAt))));
      continue;
    }

    try {
      await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close();
    const current = await readLockMetadata(lockPath);
    // Never remove a lock unless it is still the one acquired by this call.
    if (current?.token === metadata.token) await unlink(lockPath).catch(() => undefined);
  }
}

/** Write to a unique same-directory temp file and atomically rename it in. */
export async function writeJsonAtomically(path: string, value: unknown, options: JsonWriteOptions = {}): Promise<void> {
  await withFileLock(path, () => writeJsonAtomicallyUnlocked(path, value, options));
}

/** Perform a serialized read/modify/write transaction on one JSON file. */
export async function updateJsonFile<T>(
  path: string,
  initial: () => T,
  update: (current: T) => T | Promise<T>,
): Promise<T> {
  return withFileLock(path, async () => {
    let current: T;
    try {
      current = JSON.parse(await readFile(path, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      current = initial();
    }
    const next = await update(current);
    await writeJsonAtomicallyUnlocked(path, next);
    return next;
  });
}

/** Caller must hold `withFileLock(path, ...)` for read/compare/write updates. */
export interface JsonWriteOptions {
  /** One line, no indentation: for large published files nobody reads by hand. */
  compact?: boolean;
}

export async function writeJsonAtomicallyUnlocked(path: string, value: unknown, options: JsonWriteOptions = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(tmp, "wx", 0o666);
    await handle.writeFile(`${options.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, path);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
  }
}

async function readLockMetadata(path: string): Promise<Partial<FileLockMetadata> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Partial<FileLockMetadata>;
  } catch {
    return undefined;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Some filesystems/platforms do not support fsync on a directory. The
    // file itself has already been synced and the rename remains atomic.
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EBADF", "EPERM"].includes(code ?? "")) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
