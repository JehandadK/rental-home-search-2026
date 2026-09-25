import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { latestResumableRun, markInterrupted, parseDiscovered, resumeStageIndex, type RefreshRunRecord } from "./lib/refreshLedger";

function run(): RefreshRunRecord {
  return {
    schemaVersion: 1,
    id: "test",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "running",
    mode: "incremental",
    skipNifty: false,
    invocations: [{ startedAt: "2026-01-01T00:00:00.000Z", resume: false }],
    beforeTotal: 10,
    stages: [
      { id: "a", label: "A", status: "success", attempts: [] },
      { id: "b", label: "B", status: "running", attempts: [{ startedAt: "2026-01-01T00:01:00.000Z", completedAt: "", durationMs: 0, exitCode: null, status: "failed" }] },
      { id: "c", label: "C", status: "pending", attempts: [] },
    ],
  };
}

describe("refresh ledger", () => {
  it("excludes RoomSpot collection from an offline plan without excluding other sources or builds", () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const output = execFileSync(process.execPath, ["--import", "tsx", "scripts/refresh.ts", "--plan", "--skip-roomspot"], {
      cwd: root, encoding: "utf8", timeout: 10_000,
    });
    expect(output).toMatch(/^roomspot\s+REUSE \/ DISABLED$/m);
    for (const id of ["suumo", "athome", "nifty-soka", "nifty-import", "data-build", "enrich", "web-data"]) {
      expect(output).toMatch(new RegExp(`^${id}\\s+RUN$`, "m"));
    }
  });

  it("resumes at the first failed, pending, or interrupted stage", () => {
    expect(resumeStageIndex(run().stages)).toBe(1);
    const complete = run().stages.map((stage) => ({ ...stage, status: "success" as const }));
    expect(resumeStageIndex(complete)).toBe(complete.length);
  });

  it("only resumes the latest run, never an obsolete older failure", () => {
    const failed = { ...run(), status: "failed" as const };
    const success = { ...run(), id: "newer", status: "success" as const };
    expect(latestResumableRun({ schemaVersion: 1, runs: [failed, success] })).toBeUndefined();
    expect(latestResumableRun({ schemaVersion: 1, runs: [success, failed] })?.id).toBe("test");
  });

  it("turns abandoned running work into an explicit interrupted checkpoint", () => {
    const interrupted = markInterrupted(run(), "2026-01-01T00:02:00.000Z");
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.stages[1].status).toBe("failed");
    expect(interrupted.stages[1].attempts[0].durationMs).toBe(60_000);
  });

  it("parses collector and deduplicated build counts", () => {
    expect(parseDiscovered("Discovered 12 new; refreshed 3 overlaps")).toBe(12);
    expect(parseDiscovered("433 already captured, fetching 55 new.")).toBe(55);
    expect(parseDiscovered("Lifecycle vs previous build: 9 still listed, 4 NEW, 0 sold")).toBe(4);
    expect(parseDiscovered("Wrote payload")).toBeUndefined();
  });
});
